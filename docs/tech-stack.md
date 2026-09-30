---
title: 技術スタック
description: OpenCode V2 プラグインの開発に用いる言語、Deno のツールチェーン、パッケージ管理、依存関係と検証手段を記録する。
date: 2026-09-28
updated: 2026-10-01
---

## 言語

TypeScript。

OpenCode V2 Plugin APIがTypeScript/JavaScriptを前提としているため、追加の言語ランタイムやFFIは持ち込まない。

## 開発ランタイム / ツールチェーン

Denoを使用する。

Deno採用の目的は開発DXであり、JSRへの公開を目的としない。

主に以下に利用する。

- dependency installation
- task runner
- TypeScript実行
- type checking
- testing
- formatting
- linting

## Package manifest

`package.json` をpackage metadataの正本とする。

管理対象:

- `name`
- `version`
- `type`
- `exports`
- dependencies
- scripts
- npm publish metadata

Denoは `package.json` を直接利用する。

`deno.json` はDeno固有設定が必要になった場合のみ追加し、package metadataを二重管理しない。

公開物とバージョン運用の方針は [公開方針](./release-policy.md) に記録する。

## Package manager

Denoのpackage management機能を使用する。

OpenCode Plugin API等のnpm dependenciesは通常のnpm packageとして解決する。

必要に応じて `deno.lock` をコミットし、依存解決を固定する。

## Dependencies

runtime dependenciesは最小化する。

`.mcp.json` と Codex MCP 設定の型検証には Valibot を使用する。ファイル単位で検証し、成功後に変数展開や opt-in などの方針を適用する。

Codex の `.codex/config.toml` 対応には TOML パーサーとして npm package の `smol-toml` を使用する。OpenCode の実行環境でも使う依存関係として `package.json` に置き、Deno の設定と二重管理しない。パーサーの出力に対する MCP 定義の検証は、既存の JSON 入力と同様にプラグイン側で行う。

## Testing

Deno標準のtest runnerを使用する。

```bash
deno test
```

変換ロジックはOpenCode本体と分離し、純粋なunit testを中心にする。

## Lint / Format / Check

Deno標準ツールを使用する。

```bash
deno fmt
deno lint
deno check
```

独立したformatter / linter toolchainは、必要性が出るまで導入しない。
