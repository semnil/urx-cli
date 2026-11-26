# Contributing

> 日本語版は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください.

urx-cli is maintained by one person. Device definitions, value conversions and the Device Center transport live in [urx-device](https://github.com/semnil/urx-device); a report about what the device receives usually belongs there.

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Ways to help

- **File an issue** for a command that behaves wrongly: its arguments, output, exit code or lifecycle.
- **Send a pull request.** For anything that changes what is sent to the device, open an issue first: those changes need hardware evidence and land in urx-device before this repository adopts them.

## Setup

Node.js 26 (`.node-version`), pnpm (`packageManager` in `package.json`) and rustup, which installs the Rust toolchain pinned in `rust-toolchain.toml`. Clone with `--recurse-submodules`, or run `git submodule update --init` in an existing clone.

```sh
pnpm install --frozen-lockfile
pnpm build-inputs:check
pnpm version:check
pnpm typecheck
pnpm build
pnpm build:native
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

## Conventions

- Identifiers and comments in English. Comments describe behavior, not history.
- Keep diffs minimal and match the surrounding style. Formatting-only changes are not accepted on their own.
- Do not edit files under `vendor/urx-device`. A change to the shared library is made in urx-device and adopted here in its own pull request.
- Run `cargo fmt --all` for Rust changes; CI fails on the diff and does not write anything back to your branch.
- Documentation writes no control-protocol parameter number or raw value.
- Keep English and Japanese documents in sync.
