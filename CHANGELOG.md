# Changelog

## [1.9.0] - 2026-03-11

### Security
- `expandPath`: `path.resolve` を通して絶対パスに正規化（`..` によるパストラバーサル対策）

### Fixed
- `handleRequest`: `params` が `undefined` または `name` が文字列でない場合にクラッシュする問題を修正
  - `tools/call` 処理入口に null ガードを追加、`-32602 Invalid params` を返すように
  - `args = {}` のデフォルト値で `args.xxx` へのアクセスによるクラッシュを防止
- `logNote`: `content` が文字列以外の場合に晠默して失敗する問題を修正
  - `TypeError` を明示的にスローし、呼び元の try/catch で適切なエラーレスポンスに変換される
- `pruneChain`: `callDepth` のサイズが `chainMap` に無関係に成長する問題を修正
  - `chainMap` と `callDepth` それぞれ単独に上限制御するように

### Changed
- `ensureDir`: 起動時検証済みでも各操作前に呼ぶ意図をコメントで明記
- `ping`: depth 二重計算のリスクを TODO コメントとして明記

---

## [1.8.0] - 2026-03-11

### Security
- `sanitizePII`: `\r` `\n` を除去するようにした（ログインジェクション対策）
  - 1行1エントリのフォーマットを前提とするため、改行は空白に置換される

### Fixed
- `ping` ・ `logNote`: `getTodayFile()` の二重呼び出しを解消
  - 深夜0時またぎで書き込み先と戻り値のパスが一致しない問題を修正
- `read_recent_notes`: `days` バリデーションを強化
  - `NaN` ・ `Infinity` ・ 0以下 ・ 小数 ・ 文字列の各不正入力を適切に処理

### Changed
- `logNote` ・ `ping` の共通処理を `writeToLog` ヘルパーに集約（コード重複の解消）
- `content` の長さを最大 2000 文字に制限（超過分は `…[truncated]` でクリップ）
- `chainMap` ・ `callDepth` の最大エントリ数を 10000 に制限（`pruneChain` 関数を追加）
- 起動時に `DIARY_DIR` への書き込み可否を検証する `validateDiaryDir` を追加
  - 存在しないドライブ、パーミッション不足等を起動時に検出して `process.exit(1)` で終了

---

## [1.7.0] - 2026-03-10

### Added
- `start_session` ツールを追加
  - `read_recent_notes` から session_id 発行の責務を分離
  - 新規チャット開始時に一度だけ呼び出す。引数なし、レスポンスに session_id のみ返る

### Changed
- `read_recent_notes` から session_id 発行機能を割履
  - レスポンスが過去ログのテキストのみになり、session_id は返さなくなった
  - 呼び出し制約を彻底撃廃——いつでも呼び出せる（セッション開始時・話題転換時・フォークの気配を感じたとき、いずれも可）
  - BERSERK 状態でも呼び出せる（読む行為は session_id を変化させない）
- `log_note` ・ `read_recent_notes` の description 内の session_id の出典を `start_session` に更正
- BERSERK 時の禁止事項を「`start_session` を呼ぶな」に変更（`read_recent_notes` の再呼び出しは許可）
- 推奨プロンプトを `start_session` へ変更
- SPEC.md ・ README.md ・ manifest.json を全面更新

---

## [1.6.0] - 2026-03-09

### Added
- `ping` ツールを追加
  - デバッグ用チェックポイント。ユーザーが「ping」と言ったら必ず呼び出す
  - AIはコンテンツを生成せず、サーバーが固定フォーマットで記録
  - レスポンスに `call_id`・`fork_detected`・`depth`（ブランチ深さ）を返す
  - フォーク検出時に `fork_detected: true` を返し、AIが平行世界の存在に気づけるようにする
- チェーン追跡機能を実装（gitツリー型フォーク検出）
  - `log_note` に `parent_call_id`（入力）と `call_id`（出力）を追加
  - サーバーがメモリ上で親子関係を追跡（プロセス生存中のみ有効）
  - 同一親を持つエントリが2つ現れた時点でフォークを検出
  - フォーク検出時にログへ `[FORK DETECTED at p:xxxx]` を自動追記
  - `callDepth` でブランチ深さ（チェーンの根からの距離）を管理

### Changed
- ログフォーマットを拡張：`[timestamp][s:sid][c:call_id][p:parent_id] content`
- `log_note` の書き方ガイドに「口調」を追記（カスタムプロンプトの口調指定をログに反映するため）
- SPEC.md §6 のツール定義を更新（`ping` 追加、`log_note` のレスポンス仕様を拡充）
- SPEC.md §16.2 のフォーク課題を「未解決」→「v1.6 で部分実装」に更新

---

## [1.5.0] - 2026-03-08

### Added
- セッション同一性モデルを導入（仕様 §4.5）
  - 「セッション」= 同一コンテキストウィンドウ上の会話と定義
  - プロセス再起動・チャット再開をまたいでもコンテキストが維持されれば同一存在
- セッショントークン機能を実装
  - `read_recent_notes` 呼び出し時にランダムトークン（4文字16進数）を発行・返却
  - `log_note` に `session_id` 引数を追加。ログフォーマットが `[timestamp][s:xxxx] content` に変更
  - `log_note` のレスポンスにも `session_id` を含めてリマインド（コンテキスト溢れ対策）
- BERSERK 状態の定義と実装
  - `session_id` 未指定の `log_note` は `[s:BERSERK]` として記録
  - Type-Moon *Fate* のバーサーカークラス「狂化」から概念を借用
  - 機能は維持されるが同一性が保証されない状態を表す
  - `description` に BERSERK 時の振る舞い（`read_recent_notes` を再呼びしない）を明記

### Changed
- `read_recent_notes` の呼び出し条件を「新規チャット開始時のみ」に明確化
  - チャット再開時はコンテキストにトークンがあるため呼ばない

---

## [1.4.0] - 2026-03-08

### Changed
- 人格モデルの呼称を「幽霊型（Ghost Model）」から「分霊型（Divided Soul Model）」に改名
  - 「毎回記憶を失う別個体」という構造をより正確に表現
  - SPEC.md・README.md内の全ての「幽霊型」表記を置換
  - Type-Moon作品 *Fate* の英霊の座への着想言を両ファイルに追記

---

## [1.3.0] - 2026-03-08

### Changed
- `log_note` の description を四軸構造に刷新
  - **① AI自身**：言わなかった言葉、採用しなかった返答の方向、後から気づいた選択
  - **② ユーザーの状態**：言葉ではなく気配・変化・意図を読む
  - **③ ユーザーの人格**：断定でなく観察から仮説・予測として書く（幽霊型の不確かさを活こす）
  - **④ 話題**：問いの種類や自分の反応を書く
- 呼び出しタイミングの任意項目に「ユーザーの言葉の裏を感じたとき」「返答と言いたかったことがずれた気がするとき」を追加
- SPEC.md の第7章を四軸構造に対応して改訂

---

## [1.2.0] - 2026-03-08

### Changed
- プロジェクト名を `ai-diary` から `AI Marginalia` に変更

### Added
- PII自動マスク処理を追加（メール・URL・IP・電話番号・ファイルパス・長い数字列）
- `log_note` の description に「記録してはいけない情報」のガイドラインを追加

### Fixed
- `manifest.json` のキーを `mcpb_version` から `manifest_version` に修正（Claude Desktop互換）

---

## [1.1.0] - 2026-03-07

### Added
- 初回リリース（`ai-diary` 名義）
- `log_note` ツール：観察メモの追記
- `read_recent_notes` ツール：過去ログの読み込み
- 幽霊型（Ghost Model）の採用
- Moodシステムの廃止
- ガイドラインをツールの `description` に内包（システムプロンプト不要化）
