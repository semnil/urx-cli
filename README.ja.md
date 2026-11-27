# urx-cli

[English](README.md)

`urx` コマンド。つないだ YAMAHA URX22・URX44・URX44V を、端末やスクリプトから操作し、今の状態を調べる。機器の定義と Device Center との通信は [urx-device](https://github.com/semnil/urx-device) のものを使い、`vendor/urx-device` に固定した Git サブモジュール (別のリポジトリの特定のコミットを取り込む仕組み) として取り込む。

**状態:** `0.1.0` に向けた初期の開発中。コマンドはヘルプと版を表示する。機器の操作はまだできない。

## 配置

| パス | 中身 |
| --- | --- |
| `src` | `urx` コマンド: 引数・端末と JSON の出力・終了コード・プロセスの始まりと終わり |
| `native` | urx-device の通信の上に作る Node-API のアドオン (Rust、napi-rs) |
| `vendor/urx-device` | 共通ライブラリ。このリポジトリが取り込んだコミットのもの |
| `scripts` | リポジトリの道具: `build-inputs.mjs` はビルドの入力を確かめ、`build-info.mjs` は版とコミットをビルドに埋め込み、`build-native.mjs` はアドオンを組み立て、`version.mjs` は CLI の版の写しをそろえる |
| `build-inputs.json` | ビルドに使う Node・pnpm・Rust・Inno Setup の正確な版と、Node のアーカイブと Inno Setup のインストーラのハッシュ |

## ビルドとテスト

必要なもの: Node.js 26 (`.node-version`)、pnpm (`package.json` の `packageManager`)、rustup (`rust-toolchain.toml` に固定した Rust のツールチェーンを入れる)。サブモジュールごと取得する:

```sh
git clone --recurse-submodules https://github.com/semnil/urx-cli.git
cd urx-cli
pnpm install --frozen-lockfile
pnpm build-inputs:check
pnpm version:check
pnpm typecheck
pnpm build
pnpm build:native
pnpm test
```

`pnpm test` は、`pnpm build:native` が `dist/native` に組み立てたアドオンを読み込む。`pnpm build:release` は、作業ツリーではなくコミット済みのソースから両方を `dist-release` に組み立てる。`pnpm build:bundle --node-archive <path>` は、その `dist-release` と Node の公式アーカイブから、インストールする一式を `dist-bundle` に組み立てる。アーカイブは `build-inputs.json` のハッシュと照らし、何もダウンロードしない。Windows では、`node scripts/build-windows-installer.mjs --iscc <ISCC.exe のパス>` が、`build-inputs.json` に記録した版の Inno Setup で、`dist-bundle` からインストーラを `dist-installer` に組み立てる。macOS では、`node scripts/build-macos-installer.mjs` が、インストーラ一式を `dist-installer` に書く。中身は、コミット済みのソースから `dist-bundle` のリリースマニフェスト向けに組み立てた `urx-install` と、その隣の `urx-cli` に置いた一式の写しである。続けて `node scripts/build-macos-distribution.mjs` が、その一式からリリースの macOS 向けのファイルを `dist-macos` に作る。インストーラ一式を収めた読み取り専用のディスクイメージ `urx-cli-<version>-macos-arm64.dmg` と、削除ツール `urx-uninstall` をライセンス表記と一緒に収めた復旧用の ZIP `urx-cli-<version>-macos-arm64-recovery.zip` である。復旧用の ZIP は、インストールした側の削除ツールが無くなったときに、インストールを削除するためのものである。このビルドはどちらにも署名しない。どのビルドも前の出力を消さず、置き換えもしない (空のフォルダも同じ)。もう一度組み立てる前に、`dist-release`・`dist-bundle`・`dist-installer`・`dist-macos` を自分で消す。失敗したビルドは出力の場所に何も残さず、書いたファイルを隣の `dist-release.work-…`・`dist-bundle.work-…`・`dist-installer.work-…`・`dist-macos.work-…` のフォルダに残すので、それを自分で消す。

## 版

ルートの `package.json` の `version` が CLI の版。urx-device の版とは別に決める。`pnpm version:write` がアドオンのクレートの版と `Cargo.lock` のその項目をここから作り直し、`pnpm version:check` はどれかが違うと失敗する。

## 協力

[CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照。セキュリティ上の問題は [SECURITY.ja.md](SECURITY.ja.md) の手順で報告する。

## 免責

このツールは、公式の資料ではなく独自の解析で割り出した制御プロトコルで機器と通信する。機器へデータを送ることには常に危険が伴う。ソフトウェアは「現状のまま」提供され、いかなる保証も無い。作者は、使用によって生じた機器の損傷・設定の消失・その他の損害について責任を負わない。

## ライセンス

[MIT](LICENSE)。
