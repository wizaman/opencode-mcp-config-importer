# 技術スタック

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
- version bump

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

## Package manager

Denoのpackage management機能を使用する。

OpenCode Plugin API等のnpm dependenciesは通常のnpm packageとして解決する。

必要に応じて `deno.lock` をコミットし、依存解決を固定する。

## 配布

npmへpublishする。

JSRにはpublishしない。

理由:

- OpenCodeのPlugin配布経路がnpm packageを前提としている。
- JSRへ公開してもOpenCodeから直接利用できなければ配布上の価値がない。
- JSR/npmのdual publishによるrelease運用の複雑化を避ける。

## Build

可能ならbuild stepを持たない。

OpenCodeがTypeScript sourceを直接ロードできる範囲では、そのまま配布する。

buildが必要になった場合も、生成物は配布上必要な最小限に留める。

## Dependencies

runtime dependenciesは最小化する。

初期実装では、構造が単純ならZod / Valibot等のschema libraryを導入せず、必要最小限のvalidationを手書きする。

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

## Release

`package.json` のversionを正本とする。

version bumpにはDenoのversion bump機能を使用できる。

release taskは最低限、

1. test / lint / type check
2. version整合性確認
3. npm package内容の確認
4. npm publish

を再現可能にする。

Git tagやGitHub Releaseの生成をrelease taskに含めるかは、初期実装では必須としない。
