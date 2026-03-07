# Changelog

## [1.2.0] - 2026-03-08

### Changed
- プロジェクト名を `ai-diary` から `Marginalia` に変更

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
