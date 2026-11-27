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
| `build-inputs.json` | The exact Node, pnpm, Rust and Inno Setup versions and the Node archive and Inno Setup installer hashes a build uses |

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

`pnpm test` loads the addon that `pnpm build:native` built into `dist/native`. `pnpm build:release` builds both from the committed sources instead of the working tree, into `dist-release`. `pnpm build:bundle --node-archive <path>` then assembles the installed bundle from `dist-release` and the official Node archive, into `dist-bundle`; it checks the archive against the hash in `build-inputs.json` and downloads nothing. On Windows, `node scripts/build-windows-installer.mjs --iscc <path to ISCC.exe>` compiles the installer from `dist-bundle` into `dist-installer`, with the Inno Setup version that `build-inputs.json` records. On macOS, `node scripts/build-macos-installer.mjs` writes the installer tree to `dist-installer`: `urx-install`, built from the committed sources for the release manifest of `dist-bundle`, beside a copy of the bundle in `urx-cli`. `node scripts/build-macos-distribution.mjs` then makes the release's macOS files from that tree, into `dist-macos`: the read-only disk image `urx-cli-<version>-macos-arm64.dmg`, holding the installer tree, and the recovery ZIP `urx-cli-<version>-macos-arm64-recovery.zip`, holding the removal tool `urx-uninstall` with the notices, for removing an installation whose own copy is gone. Neither is signed by this build. No build removes or replaces a previous output, an empty folder included: remove `dist-release`, `dist-bundle`, `dist-installer` or `dist-macos` before building it again. A build that fails leaves nothing there; its files stay in a `dist-release.work-…`, `dist-bundle.work-…`, `dist-installer.work-…` or `dist-macos.work-…` folder beside it, which you remove.

## Versioning

The root `package.json` `version` is the CLI's version. It is independent of the urx-device version. `pnpm version:write` regenerates the addon crate's version and its `Cargo.lock` entry from it, and `pnpm version:check` fails when they differ.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through [SECURITY.md](SECURITY.md).

## Disclaimer

This tool talks to the hardware using a control protocol determined by independent analysis, not from official documentation. Sending data to hardware always carries some risk. The software is provided "as is", without warranty of any kind, and the authors are not liable for any damage to hardware, loss of settings, or other loss arising from its use.

## License

[MIT](LICENSE).
