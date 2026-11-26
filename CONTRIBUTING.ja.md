# コントリビューションガイド

> For the English version, see [CONTRIBUTING.md](CONTRIBUTING.md).

urx-cli は単独メンテナーのプロジェクトである。機器の定義・値の変換・Device Center との通信は [urx-device](https://github.com/semnil/urx-device) にある。機器が受け取る内容についての報告は、たいていそちらに出すこと。

セキュリティ上の問題は issue ではなく [SECURITY.ja.md](SECURITY.ja.md) の手順で報告すること。

## 協力できること

- **issue の登録。** コマンドの誤った振る舞い (引数・出力・終了コード・始まりと終わり) を報告する。
- **プルリクエスト。** 機器へ送る内容を変える変更は、先に issue を立てること。これらは実機での裏付けが必要で、urx-device に先に入れてから、このリポジトリが取り込む。

## セットアップ

Node.js 26 (`.node-version`)、pnpm (`package.json` の `packageManager`)。`--recurse-submodules` を付けて取得するか、取得済みのものでは `git submodule update --init` を打つ。

```sh
pnpm install --frozen-lockfile
pnpm build-inputs:check
pnpm typecheck
pnpm build
pnpm test
```

## 規約

- 識別子とコメントは英語。コメントには経緯ではなく振る舞いを書く。
- 差分は最小にし、周りの書き方に合わせる。整形だけの変更は単独では受け付けない。
- `vendor/urx-device` の下のファイルを直さない。共通ライブラリの変更は urx-device で行い、ここでは別のプルリクエストで取り込む。
- 文書には制御プロトコルのパラメータ番号も生の値も書かない。
- 英語と日本語の文書をそろえる。
