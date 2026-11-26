# urx-cli

[日本語](README.ja.md)

The `urx` command: operate a connected YAMAHA URX22, URX44 or URX44V and inspect its current state from a terminal or a script. Device definitions and the Device Center transport come from [urx-device](https://github.com/semnil/urx-device), pinned as a Git submodule at `vendor/urx-device`.

**Status:** initial development toward `0.1.0`. The command shows its help and its version; it does not operate a device yet.

## Layout

| Path | Contents |
| --- | --- |
| `src` | The `urx` command: arguments, terminal and JSON output, exit codes and process lifecycle |
| `native` | The Node-API addon over the urx-device transport (Rust, napi-rs) |
| `vendor/urx-device` | The shared library, at the commit this repository adopts |
| `scripts` | Repository tooling: `build-inputs.mjs` checks the build inputs, `build-info.mjs` embeds the versions and commits into the build, `build-native.mjs` builds the addon, `version.mjs` keeps the copies of the CLI version in step |
| `build-inputs.json` | The exact Node, pnpm and Rust versions and the Node archive hashes a build uses |

## Building and testing

Requirements: Node.js 26 (`.node-version`), pnpm (`packageManager` in `package.json`) and rustup, which installs the Rust toolchain pinned in `rust-toolchain.toml`. Clone with the submodule:

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

`pnpm test` loads the addon that `pnpm build:native` built into `dist/native`.

## Versioning

The root `package.json` `version` is the CLI's version. It is independent of the urx-device version. `pnpm version:write` regenerates the addon crate's version and its `Cargo.lock` entry from it, and `pnpm version:check` fails when they differ.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through [SECURITY.md](SECURITY.md).

## Disclaimer

This tool talks to the hardware using a control protocol determined by independent analysis, not from official documentation. Sending data to hardware always carries some risk. The software is provided "as is", without warranty of any kind, and the authors are not liable for any damage to hardware, loss of settings, or other loss arising from its use.

## License

[MIT](LICENSE).
