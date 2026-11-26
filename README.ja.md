# urx-cli

[English](README.md)

`urx` コマンド。つないだ YAMAHA URX22・URX44・URX44V を、端末やスクリプトから操作し、今の状態を調べる。機器の定義と Device Center との通信は [urx-device](https://github.com/semnil/urx-device) のものを使い、`vendor/urx-device` に固定した Git サブモジュール (別のリポジトリの特定のコミットを取り込む仕組み) として取り込む。

**状態:** `0.1.0` に向けた初期の開発中。コマンドはヘルプと版を表示する。機器の操作はまだできない。

## 配置

| パス | 中身 |
| --- | --- |
| `src` | `urx` コマンド: 引数・端末と JSON の出力・終了コード・プロセスの始まりと終わり |
| `vendor/urx-device` | 共通ライブラリ。このリポジトリが取り込んだコミットのもの |
| `scripts` | リポジトリの道具: `build-inputs.mjs` はビルドの入力を確かめ、`build-info.mjs` は版とコミットをビルドに埋め込む |
| `build-inputs.json` | ビルドに使う Node と pnpm の正確な版と、Node のアーカイブのハッシュ |

## ビルドとテスト

必要なもの: Node.js 26 (`.node-version`)、pnpm (`package.json` の `packageManager`)。サブモジュールごと取得する:

```sh
git clone --recurse-submodules https://github.com/semnil/urx-cli.git
cd urx-cli
pnpm install --frozen-lockfile
pnpm build-inputs:check
pnpm typecheck
pnpm build
pnpm test
```

## 版

ルートの `package.json` の `version` が CLI の版。urx-device の版とは別に決め、CLI の版のほかの写しはすべてここから作る。

## 協力

[CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照。セキュリティ上の問題は [SECURITY.ja.md](SECURITY.ja.md) の手順で報告する。

## 免責

このツールは、公式の資料ではなく独自の解析で割り出した制御プロトコルで機器と通信する。機器へデータを送ることには常に危険が伴う。ソフトウェアは「現状のまま」提供され、いかなる保証も無い。作者は、使用によって生じた機器の損傷・設定の消失・その他の損害について責任を負わない。

## ライセンス

[MIT](LICENSE)。
