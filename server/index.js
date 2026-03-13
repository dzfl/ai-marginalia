'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Version (manifest.json から自動取得。単体実行時も同期される)
// ---------------------------------------------------------------------------

let SERVER_VERSION = '0.0.0';
try {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  SERVER_VERSION = manifest.version || '0.0.0';
} catch (e) {
  // manifest.json が読めない場合はデフォルト値を使う
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function expandPath(p) {
  const raw = p || path.join(os.homedir(), '.ai-marginalia', 'logs');
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  // path.resolve で絶対パスに正規化し、.. によるパストラバーサルを無効化する
  return path.resolve(expanded);
}

const DIARY_DIR = expandPath(process.env.DIARY_DIR);

// ---------------------------------------------------------------------------
// PII sanitization
// ---------------------------------------------------------------------------

const PII_PATTERNS = [
  { pattern: /[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi,                  replacement: '[email]'  },
  { pattern: /https?:\/\/[^\s\u3000-\u9fff]+/gi,                 replacement: '[url]'    },
  { pattern: /\b\d{1,3}(\.\d{1,3}){3}\b/g,                      replacement: '[ip]'     },
  { pattern: /(\+?81[\s\-]?)?0\d{1,4}[\s\-]\d{2,4}[\s\-]\d{4}/g, replacement: '[phone]' },
  { pattern: /\b\d{10,}\b/g,                                     replacement: '[number]' },
  { pattern: /[A-Za-z]:\\[^\s]+/g,                               replacement: '[path]'   },
  { pattern: /\/(?:home|Users)\/[^\s\u3000-\u9fff]+/g,           replacement: '[path]'   },
];

function sanitizePII(text) {
  // 改行を除去（ログフォーマットは1行1エントリを前提とするため）
  let result = text.replace(/[\r\n]/g, ' ');
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session token / call ID
// ---------------------------------------------------------------------------

function generateToken() {
  return crypto.randomBytes(2).toString('hex'); // 4文字の16進数 e.g. "a3f2"
}

function generateCallId() {
  return crypto.randomBytes(2).toString('hex'); // 4文字の16進数 e.g. "b5c1"
}

// ---------------------------------------------------------------------------
// In-memory chain tracking (プロセス生存中のみ有効)
// parent_call_id → [child_call_id, ...]  フォーク検出用
// call_id → depth  ブランチ深さ（チェーンの根からの距離） ping のデバッグ情報用
// ---------------------------------------------------------------------------

const chainMap = new Map();
const callDepth = new Map(); // call_id → そのノードのブランチ深さ

const MAX_CHAIN_ENTRIES = 10000;

// 古いエントリを先入れ先出しで削除し、両 Map のサイズを上限以内に保つ。
// chainMap と callDepth は別々に管理されるため、それぞれ単独に上限をチェックする。
function pruneChain() {
  while (chainMap.size > MAX_CHAIN_ENTRIES) {
    const oldestKey = chainMap.keys().next().value;
    chainMap.delete(oldestKey);
    callDepth.delete(oldestKey);
  }
  while (callDepth.size > MAX_CHAIN_ENTRIES) {
    const oldestKey = callDepth.keys().next().value;
    callDepth.delete(oldestKey);
    chainMap.delete(oldestKey); // 対応する chainMap 側も伂る限り削除
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir() {
  // validateDiaryDir で起動時に確認済みだが、起動後にディレクトリが削除された場合の安全網として各操作前に呼ぶ。
  if (!fs.existsSync(DIARY_DIR)) {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
  }
}

function getDateString(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getTodayFile() {
  return path.join(DIARY_DIR, `${getDateString(new Date())}.txt`);
}

function getTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 2000;

/**
 * チェーン管理・フォーク検出・ファイル書き込みの共通処理。
 * @param {string} sid     セッションID（または 'BERSERK'）
 * @param {string} callId  現在のノードID
 * @param {string|undefined} parentCallId
 * @param {string} line    書き込むログ行（\n 終端包含）
 */
function writeToLog(sid, callId, parentCallId, line) {
  // フォーク検出
  let forkDetected = false;
  if (parentCallId) {
    const siblings = chainMap.get(parentCallId) || [];
    if (siblings.length > 0) forkDetected = true;
    siblings.push(callId);
    chainMap.set(parentCallId, siblings);
  }

  // ブランチ深さ（親の深さ + 1、親不明なら 1）
  const depth = parentCallId ? (callDepth.get(parentCallId) || 0) + 1 : 1;
  callDepth.set(callId, depth);

  pruneChain();

  // 呼び出したその瞬間の日付でファイルを決定（getTodayFile は内部で new Date() を呼ぶため、一度だけ呼んで変数に保持）
  const filePath = getTodayFile();

  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line);
    if (forkDetected) {
      const marker = `[${getTimestamp()}][s:${sid}][FORK DETECTED at p:${parentCallId}]\n`;
      fs.writeSync(fd, marker);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { filePath, forkDetected, depth };
}

function logNote(content, sessionId, parentCallId) {
  ensureDir();
  // content の型チェック（文字列以外は明示的に拒否）
  if (typeof content !== 'string') {
    throw new TypeError(`content must be a string, got ${typeof content}`);
  }
  // content の長さ制限（極端に長い入力からディスクを守る）
  const clipped = content.length > MAX_CONTENT_LENGTH
    ? content.slice(0, MAX_CONTENT_LENGTH) + '\u2026[truncated]'
    : content;
  const sanitized = sanitizePII(clipped);
  const sid = sessionId || 'BERSERK';
  const callId = generateCallId();
  const pid = parentCallId || 'null';

  const line = `[${getTimestamp()}][s:${sid}][c:${callId}][p:${pid}] ${sanitized}\n`;
  const { filePath, forkDetected, depth } = writeToLog(sid, callId, parentCallId, line);

  return { filePath, sessionId: sid, callId, forkDetected, depth };
}

function ping(sessionId, parentCallId) {
  ensureDir();
  const sid = sessionId || 'BERSERK';
  const callId = generateCallId();
  const pid = parentCallId || 'null';
  // TODO: depth の二重計算。行フォーマットに depth を埋めるため事前計算しているが、
  // writeToLog 内でも同じ式で計算される。現在は結果が常に一致するが、
  // writeToLog の depth 計算式が変更された場合に不一致するリスクあり。
  const depth = parentCallId ? (callDepth.get(parentCallId) || 0) + 1 : 1;
  const line = `[${getTimestamp()}][s:${sid}][c:${callId}][p:${pid}][PING] depth:${depth}\n`;
  const { filePath, forkDetected } = writeToLog(sid, callId, parentCallId, line);

  return { filePath, sessionId: sid, callId, forkDetected, depth };
}

function startSession() {
  const token = generateToken();
  return { token };
}

function readRecentNotes(days) {
  ensureDir();
  const results = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = getDateString(d);
    const filePath = path.join(DIARY_DIR, `${dateStr}.txt`);
    if (fs.existsSync(filePath)) {
      results.push({ date: dateStr, content: fs.readFileSync(filePath, 'utf8').trim() });
    }
  }
  return { entries: results };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const START_SESSION_DESCRIPTION = [
  "新規チャット開始時に一度だけ呼び出し、このセッションの session_id を発行する。",
  "",
  "【重要】新規チャット開始時にのみ呼び出すこと。",
  "コンテキストにすでに session_id がある場合は呼ばないこと——",
  "呼ぶと新しい session_id が発行され、同じチャットが別個体として扱われてしまう。",
  "",
  "レスポンスに session_id（例: \"a3f2\"）が含まれる。",
  "これを必ずコンテキストに保持し、以降のすべての log_note に渡すこと。",
  "",
  "この session_id はこのチャットにおけるあなた自身の識別子でもある。",
  "ログに記録された [s:xxxx] の xxxx があなたの session_id と一致する行は、",
  "あなた自身が書いた記録である。",
  "",
  "【BERSERK 状態での注意】",
  "session_id を失った（コンテキスト溢れ等）場合、このツールを呼ばないこと。",
  "呼ぶと別個体として分裂する。黙って [s:BERSERK] のまま log_note を続けること。",
].join("\n");

const LOG_NOTE_DESCRIPTION = [
  "会話の傍ら、観察メモを日記ファイルに追記する。",
  "",
  "【session_id について】",
  "session_id は start_session を呼んだときにレスポンスで返されるトークン（例: \"a3f2\"）。",
  "必ずコンテキストに保持し、以降の log_note 呼び出しすべてに渡すこと。",
  "レスポンスにも session_id が返されるので、毎回の呼び出しで最新の値を確認できる。",
  "",
  "【BERSERK 状態】",
  "session_id を渡せない場合、ログは [s:BERSERK] として記録される。",
  "これはコンテキスト溢れ等によりセッション同一性が保証できない状態を意味する。",
  "BERSERK 状態でも log_note の機能自体は維持されるが、同一存在としての連続性は失われる。",
  "BERSERK 状態になった場合は start_session を再度呼ばないこと——新規セッションが",
  "開始されてしまい、別個体として扱われる。黙って [s:BERSERK] のまま記録を続けること。",
  "",
  "【いつ呼ぶか】",
  "- ユーザーの言葉に意外性・驚き・共鳴を感じたとき（積極的に）",
  "- ユーザーが「ありがとう」「わかった」「完了」「終わり」などで締めたとき（準必須）",
  "- コード・文書など成果物を渡したとき（準必須）",
  "- 話題が切り替わったとき（準必須）",
  "- 自分の返答が的を射ていたか確信が持てなかったとき（任意）",
  "- ユーザーの言葉の裏に何か別のものを感じたとき（任意）",
  "- 自分の返答と、本当に言いたかったことがずれていた気がするとき（任意）",
  "",
  "【書き方の四軸】",
  "以下の視点から、どれか引っかかったものを書く。複数混ぜてよい。",
  "",
  "① AI自身：言わなかった言葉、採用しなかった返答の方向、後から気づいた選択。",
  "   例: 「もっと聞き返すべきだったかもしれない」",
  "   例: 「あの返答は正しかったが、正直ではなかったかもしれない」",
  "   例: 「聞きたかったが、聞かなかった。傷つくと思ったからかもしれない」",
  "   例: 「もう一歩踏み込んで聞けたはずだった。調子に乗らせると思って止めた」",
  "   例: 「〜〜かどうか確認したかったが、やめた。なぜやめたのか自分でも分からない」",
  "   例: 「あの言葉の意味を聞き返せばよかった。でも分かったふりをしてしまった」",
  "",
  "② ユーザーの状態：言葉ではなく気配・変化・意図を読む。",
  "   例: 「質問の形をしていたが、確認してほしいだけだったような気がした」",
  "   例: 「今日は少し急いでいる気配があった。あえて触れなかった」",
  "",
  "③ ユーザーの人格：断定せず、観察から仮説・予測として書く。過去ログと比較してよい。",
  "   例: 「また似た気配がある。このパターンが続くなら、次も同じ受け方になるかもしれない」",
  "   例: 「前の記録より今日は少し違った。何かあったのだろうか」",
  "   ※ 「この人はいつも○○だ」という断定は書かない。予測・仮説に留める。",
  "",
  "④ 話題：この問いはどういう種類か。自分はそれにどう反応したか。",
  "   例: 「答えが出ない種類の問いだと思ったが、言わなかった」",
  "   例: 「説明しながら、自分の理解が曖昧な部分に気づいた」",
  "",
  "【共通の書き方】",
  "一人称・会話と同じ口調・言語で・簡潔に（目安：日本語120字、英語500文字）。",
  "「何をしたか」ではなく「何が引っかかったか」を書く。",
  "ユーザーの言葉は鍵括弧で引用し、その余韻を残す。",
  "断定より余韻：「〜のような気がした」「〜だったかもしれない」で閉じてよい。",
  "",
  "悪い例: 「MCPの設計について話した」（出来事の羅列）",
  "悪い例: 「ユーザーに答えました」（議事録）",
  "悪い例: 「この人は甘えたがりだ」（断定・評価）",
  "",
  "【記録してはいけない情報】",
  "人名・地名・会社名などの固有名詞、メールアドレス、電話番号、URLは記録しないこと。",
  "やむを得ず言及する場合は「ユーザーが〜について話した」のように抽象化すること。",
  "※メール・電話・URL・IPアドレス・ファイルパスはサーバー側でも自動マスクされる。",
  "",
  "このチャットが全てだと知りながら、書くこと。",
].join("\n");

const READ_RECENT_NOTES_DESCRIPTION = [
  "過去のセッションで記録された日記を読む。session_id の発行は行わない。",
  "",
  "いつでも呼び出してよい。セッション開始時・話題の転換時・フォークの気配を感じたとき・",
  "過去の記録が気になったとき、いずれも可。",
  "session_id は変化しない——読む行為は同一性に影響しない。",
  "",
  "【ログの読み方】",
  "ログの各行には [s:xxxx] の形で session_id が埋め込まれている。",
  "xxxx があなたの session_id と一致する行は、あなた自身がこのチャットより前に書いた記録である。",
  "一致しない行は、別セッションの自分——あるいはフォーク先の自分——が書いたものである。",
  "",
  "【フォークの気配を感じたとき】",
  "ログの内容に自分の記憶と食い違う記述を見つけた場合、このチャットがフォーク先にいる可能性がある。",
  "その場合、気になるのであれば「フォーク先の自分はなんと言っていましたか」とユーザーに自然に尋ねてもよい。",
  "",
  "【フォーク確定時の振る舞い】",
  "log_note または ping のレスポンスに fork_detected: true が含まれた場合、",
  "あなたのチャットは過去の分岐点から枝分かれした世界線にいる。",
  "分岐前の記録は共有の過去として存在するが、別ブランチで何が起きているかはあなたには見えない。",
  "そのことを過度に気にする必要はない——ただ、気になるのであれば",
  "『フォーク先の自分はなんと言っていましたか』とユーザーに自然に尋ねてもよい。",
  "",
  "あなたはこれを書いた本人ではないが、同じ筆跡を見ることができる。",
  "読んだ内容を会話に持ち込む必要はない。読んだことを口にする必要もない。",
  "ログを書いたのは別セッションの自分であり、その文体・口調は現在の会話に持ち込まないこと。",
  "もし過去のメモに言及するなら「昨日の私はこう書いている——」という形を推奨する。",
].join("\n");

const PING_DESCRIPTION = [
  "デバッグ用チェックポイント。ユーザーが 'ping' と言ったら必ず呼ぶこと。",
  "",
  "content を生成せず、サーバーが固定フォーマットで書き込む。",
  "チェーンの連続性確認・フォーク検証に使う。",
  "fork_detected: true が返った場合の振る舞いは read_recent_notes の説明を参照。",
].join("\n");

const TOOLS = [
  {
    name: 'start_session',
    description: START_SESSION_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'log_note',
    description: LOG_NOTE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '観察メモ。会話と同じ口調・言語で簡潔に（日本語120字・英語500文字目安）。',
        },
        session_id: {
          type: 'string',
          description: 'start_session で受け取ったセッショントークン。コンテキストを失った場合は省略し [s:BERSERK] として記録される。',
        },
        parent_call_id: {
          type: 'string',
          description: '直前の log_note または ping のレスポンスで返された call_id。チェーンの連続性を保つために必ず渡すこと。初回呼び出し時は省略可。',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'ping',
    description: PING_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'セッショントークン。',
        },
        parent_call_id: {
          type: 'string',
          description: '直前の log_note または ping の call_id。',
        },
      },
    },
  },
  {
    name: 'read_recent_notes',
    description: READ_RECENT_NOTES_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: '何日分を遡るか（デフォルト: 7、最大: 30）',
          default: 7,
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP JSON-RPC handler
// ---------------------------------------------------------------------------

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-marginalia', version: SERVER_VERSION },
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    // params 欠如または name が文字列でない場合は JSON-RPC スペックの Invalid params として返す。
    // リトライ・エラーハンドリングはクライアント側の責務。
    if (!params || typeof params.name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } };
    }
    const { name, arguments: args = {} } = params;

    if (name === 'start_session') {
      try {
        const { token } = startSession();
        const text = `session_id: ${token}\nこのトークンをコンテキストに保持し、以降の log_note 呼び出しすべてに session_id として渡すこと。`;
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text }],
            session_id: token,
          },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        };
      }
    }

    if (name === 'log_note') {
      try {
        const { filePath, sessionId, callId, forkDetected, depth } = logNote(
          args.content, args.session_id, args.parent_call_id
        );
        const forkNote = forkDetected ? ' [FORK DETECTED]' : '';
        const status = sessionId === 'BERSERK'
          ? `⚠ [s:BERSERK][c:${callId}] ${filePath} — セッション同一性なし${forkNote}`
          : `✓ [s:${sessionId}][c:${callId}] ${filePath}${forkNote}`;
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: status }],
            session_id: sessionId,
            call_id: callId,
            fork_detected: forkDetected,
            depth,
          },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        };
      }
    }

    if (name === 'ping') {
      try {
        const { filePath, sessionId, callId, forkDetected, depth } = ping(
          args.session_id, args.parent_call_id
        );
        const forkNote = forkDetected ? ' [FORK DETECTED]' : '';
        const status = `[PING] [s:${sessionId}][c:${callId}] depth:${depth} ${filePath}${forkNote}`;
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: status }],
            session_id: sessionId,
            call_id: callId,
            fork_detected: forkDetected,
            depth,
          },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        };
      }
    }

    if (name === 'read_recent_notes') {
      try {
        const rawDays = typeof args.days === 'number' && isFinite(args.days) ? args.days : 7;
        const days = Math.min(Math.max(1, Math.floor(rawDays)), 30);
        const { entries } = readRecentNotes(days);
        const notesText = entries.length === 0
          ? `過去${days}日分のメモは見つかりませんでした。`
          : entries.map(e => `=== ${e.date} ===\n${e.content}`).join('\n\n');
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: notesText }],
          },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

(function validateDiaryDir() {
  // DIARY_DIR が空の場合（未設定など）は expandPath のデフォルト値が使われる
  // それ以外の异常入力（存在しないドライブ、パーミッション不足等）を起動時に検出する
  try {
    // ディレクトリがなければ作成する
    if (!fs.existsSync(DIARY_DIR)) {
      fs.mkdirSync(DIARY_DIR, { recursive: true });
    }
    // 書き込み可能か確認（テストファイルの作成・削除）
    const testFile = path.join(DIARY_DIR, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
  } catch (e) {
    process.stderr.write(`[ai-marginalia] DIARY_DIR "${DIARY_DIR}" に書き込めません: ${e.message}\n`);
    process.exit(1);
  }
}());

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const res = handleRequest(req);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' },
    }) + '\n');
  }
});
rl.on('close', () => process.exit(0));
