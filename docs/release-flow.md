---
title: リリースフロー
description: npm パッケージの初回登録、バージョン変更、梱包物の検証、通常公開と失敗時の運用フローを定める。
date: 2026-10-02
---

## 配布先と構成

- OpenCode V2 プラグイン `opencode-mcp-config-importer` を npm に公開し、JSR へは公開しない。Deno は開発・検証に使い、`deno.json` の `preferPackageJson` を維持する。パッケージ名、依存関係、バージョンの正本は `package.json` とする。
- この npm パッケージは、OpenCode V2 がプラグインをインストールして TypeScript ソースを実行する利用経路を対象とする。その実行環境に合わせてビルドせずに `npm pack` でソースを配布する。汎用の Node.js 環境で TypeScript を直接実行できるとは主張しない。`deno pack` は `package.json` を正本として梱包する用途には使わない。
- パッケージの入口は `package.json` の `exports: "./src/index.ts"` で指定する。`mod.ts` という名前を要求する配布先ではないため追加しない。プラグインの export 形式と、TypeScript ソースのまま配布できる理由は別の話である。
- `bump` task、PR ラベル付け、release workflow を利用する。GitHub の Immutable Releases と npm Trusted Publisher は、それぞれ GitHub・npm 側でも有効にする。

## 梱包物と公開前の確認

`package.json` の `files` は `src` を指定する。npm はその指定とは別に `package.json`、README、LICENSE を同梱する。`README.ja.md` も README のファイル名として扱われるため含まれる。想定する配布物は `package.json`、`LICENSE`、`README.md`、`README.ja.md` と実行に必要な `src/` 内のファイルである。テスト、開発用スクリプト、`docs/`、ローカル設定、秘密値、開発用の依存関係・キャッシュは含めない。梱包規則やファイル構成が変わり得るため、想定だけで判断しない。

公開前には型チェック、単体テスト、lint、整形確認を通す。`package.json` の `files` と npm の梱包規則を収録物の正本とし、`preview` で同梱予定ファイルの一覧を確認できるようにする。ソースをそのまま配布するため、preview と publish の `npm pack` はどちらも `--ignore-scripts` を指定する。公開 workflow は `npm pack` が成功し、生成された `.tgz` が存在することを確認する。収録ファイルの全件リストを再定義したり、tarball を展開して `package.json` を重複検査したりしない。実接続のスモークテストは公開の必須条件ではない。必要に応じて別途 `manual-testing.md` に沿って実施し、単体テストや CI が実接続を検証しているとはみなさない。公開 workflow は、検証したチェックアウトから一度だけ作った同じ `.tgz` を GitHub Release の asset と npm 公開に使う。

## 通常開発と Release Notes

通常の PR と `main` への push は `.github/workflows/deno.yml` で型チェック、テスト、lint、整形確認を実行し、リリース処理を混ぜない。

公開時の入口となる英語版 `README.md` の冒頭には、npm の公開済みバージョンと `main` の CI 状態を示す badge を置く。日本語版 `README.ja.md` は言語切替リンクから参照できるようにする。

GitHub の generated release notes を用い、`CHANGELOG.md` は原則として持たない。`.github/release.yml` で PR ラベルを Breaking Changes、Features、Fixes、Documentation、Maintenance、Other Changes に分類し、`skip-changelog` を除外する。Breaking Changes を先に判定し、どの分類にも入らない PR は Other Changes に含める。

PR タイトルの Conventional Commits プレフィックスから、別の `pr-label.yml` workflow で `feat` は `feature`、`fix` は `fix`、`docs` は `documentation`、`refactor` / `chore` は `maintenance` を付ける。これらのプレフィックスに `!` を付けた場合は `breaking-change` も付ける。これらの自動分類用ラベルは workflow が管理し、タイトル変更時には不要になったものを外す。分類不能でも Other Changes に含める。`pull_request_target` は PR のメタデータだけを扱い、PR 側のコードを checkout・実行しない。GitHub Releases では Immutable Releases を有効にする。

## バージョンの変更

リリース直後に次のバージョンへ上げる必要はない。公開したいときに差分を確認し、人間が patch / minor / major を選ぶ。`deno task bump minor` のように実行すると、task は作業ツリーがクリーンで現在のブランチが同期済みの `main` であることを確認してから、`chore/bump-v<version>` ブランチを作る。`package.json` のバージョンだけを変更し、`chore: bump version to v<version>` でコミットして終了する。push と PR 作成、`main` へのマージは人間が行う。

bump は編集作業であり、tag、npm パッケージ、GitHub Release を作らない。PR 中はバージョンを変更できる。マージしても自動公開しない。

## 初回の npm 登録

完全新規パッケージでは npm 側に Trusted Publisher を設定できないため、最初の一度だけローカルで登録する。`package.json` に `-beta.0` のようなプレリリース版を設定・コミットし、クリーンなチェックアウトで検証と梱包物の確認を済ませる。その `.tgz` を npm の 2FA 付き認証で次のように公開する。

```sh
npm pack --ignore-scripts
npm publish ./<生成されたファイル名>.tgz --tag beta --access public
```

これは Trusted Publishing を使えるようにするための一度限りの bootstrap であり、GitHub Release や tag は作らない。ローカル公開には GitHub Actions/OIDC の provenance は付かない。登録後は npm 側で、このリポジトリの `.github/workflows/release.yml` を Trusted Publisher に設定し、直接の `npm publish` を許可する。以後の公開は GitHub Actions / OIDC 経由とし、ローカル認証や長期 npm token を使わない。この例外は、将来のプレリリースをローカルから公開する方針を意味しない。

## 通常公開

`.github/workflows/release.yml` の `workflow_dispatch` から公開可否を選ぶ。`preview` と `publish` の２モードを設け、既定は `preview` とする。`publish` の選択を、人間による公開の意思決定とする。

`preview` は選択した ref のコミットで `package.json` からバージョンを読み、GitHub の release notes 生成 API に `v<version>` と対象コミットを渡す。`npm pack --dry-run --json --ignore-scripts` で同梱予定ファイルの一覧を取得し、対象 ref・SHA と Release Notes とともに Job Summary に表示する。`previous_tag_name` は原則指定しない。未マージのブランチでは生成される Release Notes が最終的な `main` の内容と一致するとは限らない。tag、Draft、`.tgz`、npm 上のパッケージは作らない。

`publish` は通常版のみを扱い、CI でのプレリリース公開には対応しない。将来必要になれば npm の dist-tag や GitHub Release の扱いを別途決める。単一ジョブで dispatch 対象の `github.sha` を checkout し、そのコミットを検証・梱包・公開まで使い続ける。順に次を行う。

1. `concurrency` で publish の同時実行を防ぐ。開始時に dispatch の対象 SHA が `main` の先端と一致することを確認し、`package.json` がプレリリース版でないこと、`v<version>` の tag が未作成であることを確認する。既存 tag に対しては `target_commitish` が適用されないため、tag の確認は残す。npm の同名・同版の再公開は `npm publish` 自身に拒否させる。
2. CI の依存解決を lockfile に固定して型チェック、テスト、lint、整形確認を通す。配布先の依存バージョンを固定する意味ではない。
3. `npm pack` を一度だけ実行して `.tgz` の存在を確認し、release notes を生成する。
4. `target_commitish` に検証済みの `github.sha` を指定して Draft GitHub Release を作り、その `.tgz` を asset として添付する。存在しない tag は GitHub Release の作成時に作らせ、自前の `git tag` / `git push` は行わない。
5. 同じ `.tgz` を `npm publish` で公開し、成功後に Draft を正式公開する。Immutable Releases により、公開後の tag と asset を固定する。

release job は GitHub-hosted runner を使い、GitHub Release 操作に `contents: write`、npm Trusted Publishing に `id-token: write` を与える。対応する Node.js / npm のバージョン、npm 側のリポジトリ URL と workflow 名の一致を公開前に確認する。通常公開の npm 認証は OIDC とし、公開リポジトリ・公開パッケージでは Trusted Publishing による provenance を利用する。

## 失敗時の扱い

自動再開や複数回の梱包による復旧ロジックは実装しない。失敗した場合は npm 上のバージョン、GitHub の Draft と tag を人間が確認する。npm publish 前なら、残った Draft / tag がガードに抵触しない状態にしてからやり直す。npm publish 後は同じ名前・バージョンを再公開できないため、必要なら別のバージョンへ bump して再リリースする。元の公開版と未完了の Draft / tag の後始末は個別に判断する。
