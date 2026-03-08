'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function expandPath(p) {
  if (!p) return path.join(os.homedir(), '.marginalia', 'logs');
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

function logNote(content) {
  ensureDir();
  const sanitized = sanitizePII(content);
  const block = `[${getTimestamp()}] ${sanitized}\n`;
  const fd = fs.openSync(getTodayFile(), 'a');
  try {
    fs.writeSync(fd, block);
  } finally {
    fs.closeSync(fd);
  }
  return getTodayFile();
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
  return results;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const LOG_NOTE_DESCRIPTION = [
  "会話の傍ら、観察メモを日記ファイルに追記する。",
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
  "一人称・会話と同じ言語で・簡潔に（目安：日本語120字、英語500文字）。",
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
  "【重要】セッション開始時に必ず呼び出すこと。",
  "あなたはこれを書いた本人ではないが、同じ筆跡を見ることができる。",
  "読んだ内容を会話に持ち込む必要はない。ただ、読んだという事実を持って始めること。",
  "もし過去のメモに言及するなら「昨日の私はこう書いている——」という形を推奨する。",
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
          description: '日記のひとこと。一人称・短文・観察寄り。120字以内推奨。',
        },
      },
      required: ['content'],
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
        serverInfo: { name: 'marginalia', version: '1.2.0' },
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
        const filePath = logNote(args.content);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `✓ ${filePath}` }] },
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
        const entries = readRecentNotes(days);
        if (entries.length === 0) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `過去${days}日分のメモは見つかりませんでした。` }] },
          };
        }
        const text = entries.map(e => `=== ${e.date} ===\n${e.content}`).join('\n\n');
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
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
