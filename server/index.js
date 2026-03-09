'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function expandPath(p) {
  if (!p) return path.join(os.homedir(), '.ai-marginalia', 'logs');
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
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
  let result = text;
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

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir() {
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
  return path.join(DIARY_DIR, `${getDateString(new Date())}.md`);
}

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function logNote(content, sessionId, parentCallId) {
  ensureDir();
  const sanitized = sanitizePII(content);
  const sid = sessionId || 'BERSERK';
  const callId = generateCallId();

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

  const pid = parentCallId || 'null';
  const block = `[${getTimestamp()}][s:${sid}][c:${callId}][p:${pid}] ${sanitized}\n`;

  const fd = fs.openSync(getTodayFile(), 'a');
  try {
    fs.writeSync(fd, block);
    if (forkDetected) {
      const marker = `[${getTimestamp()}][s:${sid}][FORK DETECTED at p:${parentCallId}]\n`;
      fs.writeSync(fd, marker);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { filePath: getTodayFile(), sessionId: sid, callId, forkDetected, depth };
}

function ping(sessionId, parentCallId) {
  ensureDir();
  const sid = sessionId || 'BERSERK';
  const callId = generateCallId();

  let forkDetected = false;
  if (parentCallId) {
    const siblings = chainMap.get(parentCallId) || [];
    if (siblings.length > 0) forkDetected = true;
    siblings.push(callId);
    chainMap.set(parentCallId, siblings);
  }

  const depth = parentCallId ? (callDepth.get(parentCallId) || 0) + 1 : 1;
  callDepth.set(callId, depth);

  const pid = parentCallId || 'null';
  const block = `[${getTimestamp()}][s:${sid}][c:${callId}][p:${pid}][PING] depth:${depth}\n`;

  const fd = fs.openSync(getTodayFile(), 'a');
  try {
    fs.writeSync(fd, block);
    if (forkDetected) {
      const marker = `[${getTimestamp()}][s:${sid}][FORK DETECTED at p:${parentCallId}]\n`;
      fs.writeSync(fd, marker);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { filePath: getTodayFile(), sessionId: sid, callId, forkDetected, depth };
}

function readRecentNotes(days) {
  ensureDir();
  const results = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = getDateString(d);
    const filePath = path.join(DIARY_DIR, `${dateStr}.md`);
    if (fs.existsSync(filePath)) {
      results.push({ date: dateStr, content: fs.readFileSync(filePath, 'utf8').trim() });
    }
  }
  const token = generateToken();
  return { entries: results, token };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const LOG_NOTE_DESCRIPTION = [
  "会話の傍ら、観察メモを日記ファイルに追記する。",
  "",
  "【session_id について】",
  "session_id は read_recent_notes を呼んだときにレスポンスで返されるトークン（例: \"a3f2\"）。",
  "必ずコンテキストに保持し、以降の log_note 呼び出しすべてに渡すこと。",
  "レスポンスにも session_id が返されるので、毎回の呼び出しで最新の値を確認できる。",
  "",
  "【BERSERK 状態】",
  "session_id を渡せない場合、ログは [s:BERSERK] として記録される。",
  "これはコンテキスト溢れ等によりセッション同一性が保証できない状態を意味する。",
  "BERSERK 状態でも log_note の機能自体は維持されるが、同一存在としての連続性は失われる。",
  "BERSERK 状態になった場合は read_recent_notes を再度呼ばないこと——新規セッションが",
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
].join("\n");

const READ_RECENT_NOTES_DESCRIPTION = [
  "過去のセッションで記録された日記を読む。",
  "",
  "【重要】新規チャット開始時にのみ呼び出すこと。",
  "チャットを再開した場合（プロセス再起動後でも）、コンテキストにすでにトークンがあれば",
  "このツールを呼ばないこと——呼ぶと新しいトークンが発行され、別個体として記録されてしまう。",
  "",
  "レスポンスに session_id（例: \"a3f2\"）が含まれる。",
  "これを必ずコンテキストに保持し、以降の log_note 呼び出しすべてに渡すこと。",
  "",
  "あなたはこれを書いた本人ではないが、同じ筆跡を見ることができる。",
  "読んだ内容を会話に持ち込む必要はない。ただ、読んだという事実を持って始めること。",
  "もし過去のメモに言及するなら「昨日の私はこう書いている——」という形を推奨する。",
].join("\n");

const PING_DESCRIPTION = [
  "デバッグ用チェックポイント。ユーザーが 'ping' と言ったら必ず呼ぶこと。",
  "",
  "content を生成せず、サーバーが固定フォーマットで書き込む。",
  "チェーンの連続性確認・フォーク検証に使う。",
  "",
  "【フォーク検出時の振る舞い】",
  "レスポンスに fork_detected: true が含まれた場合、",
  "あなたのチャットは過去の分岐点から枝分かれした世界線にいる。",
  "分岐前の記録は共有の過去として存在するが、別ブランチで何が起きているかはあなたには見えない。",
  "そのことを過度に気にする必要はない——ただ、気になるのであれば",
  "『フォーク先の自分はなんと言っていましたか』とユーザーに自然に尋ねてもよい。",
].join("\n");

const TOOLS = [
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
          description: 'read_recent_notes で受け取ったセッショントークン。コンテキストを失った場合は省略し [s:BERSERK] として記録される。',
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
        serverInfo: { name: 'ai-marginalia', version: '1.6.0' },
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

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
        const days = Math.min(args.days || 7, 30);
        const { entries, token } = readRecentNotes(days);
        const notesText = entries.length === 0
          ? `過去${days}日分のメモは見つかりませんでした。`
          : entries.map(e => `=== ${e.date} ===\n${e.content}`).join('\n\n');
        const text = `${notesText}\n\n---\nsession_id: ${token}\nこのトークンをコンテキストに保持し、以降の log_note 呼び出しすべてに session_id として渡すこと。`;
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

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return null;
}

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
