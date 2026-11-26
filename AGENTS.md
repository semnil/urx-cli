# AGENTS.md — urx-cli

## Overview

The `urx` command line tool for the YAMAHA URX22 / URX44 / URX44V: one-shot reads and writes, watches, command files, an interactive console and settings-file import. It consumes the shared library [urx-device](https://github.com/semnil/urx-device) as a pinned Git submodule at `vendor/urx-device`: device definitions, semantic operations and the Device Center transport live there, not here.

## Structure

- `src/` — the command: argument grammar, help and version, terminal and JSON output, exit codes, process lifecycle. `src/cli/commands.ts` is the command-binding table that the parser and help both read
- `native/` — the Node-API addon (napi-rs) over the urx-device transport crate. `src/native/addon.ts` loads it and checks its build identity before any device access; `src/native/device.ts` discovers, selects, opens and closes devices through it, validating every record with urx-device's validators
- `test/device-center-peer.ts` — a controlled local Device Center peer for the addon's integration tests (K30). It supplies protocol replies and faults, not a model of a unit
- `vendor/urx-device/` — the shared library at the adopted commit. Never edited here. Its control package is a pnpm workspace member (`@urx/device-control`), compiled by `pnpm build:common`; its transport crate is a path dependency kept out of the Cargo workspace, so its own checks stay in urx-device
- `scripts/` — repository tooling: `build-inputs.mjs` (checks the build inputs), `build-info.mjs` (writes `dist/build-info.js`, the versions and commits that `urx --version` shows), `build-native.mjs` (builds `dist/native/urx-native.node` with the same urx-device identity), `source-info.mjs` (how both read a checkout's versions and commits), `release-source.mjs` (the release source check), `release-build.mjs` (the release build) and `version.mjs` (the addon crate's copy of the CLI version)
- `build-inputs.json` — the exact Node, pnpm and Rust versions and Node archive hashes a build uses, the one record of them
- `.github/required-checks.json` — the status checks the `main` ruleset requires, the only copy outside GitHub's settings

## Development

```sh
git submodule update --init
pnpm install --frozen-lockfile
pnpm build-inputs:check   # build-inputs.json agrees with .node-version, package.json and rust-toolchain.toml
pnpm version:check        # the addon crate's version and Cargo.lock entry match package.json
pnpm typecheck            # the control package, then the source and test configs
pnpm build                # tsc emit of src/ into dist/, then dist/build-info.js from the checkout
pnpm build:native         # the addon into dist/native/; pnpm test loads it
pnpm test                 # vitest: src/**/*.test.ts, test/**/*.test.ts and scripts/**/*.test.mjs
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

A local verification names every one of these commands; a command left out is named as left out in the report.

## Boundaries

- **Device semantics belong to urx-device.** This repository owns command parsing, help, terminal and JSON output, exit codes and process lifecycle. A setting, value rule, composition order or request sequence is never re-implemented here, and there is no CLI-only setter. A missing or wrong operation is fixed in urx-device first and adopted here in its own pull request
- **Adoption is a pull request of its own.** It moves the `vendor/urx-device` gitlink to a released urx-device commit, with the adapter and lockfile changes it needs and this repository's checks. Nothing else pins the common commit, and no scheduled update moves it
- **No added device reads or writes.** A command performs the reads and writes its operations define: no equality checks, readback, status polling, retries, automatic reconnection, command replay or settings restoration. Tests compare request traces with the defined reads and writes

## Documentation

- **English is the base language.** This file is English only and has no Japanese counterpart. Every other document for readers has its English text at its own path and a Japanese counterpart beside it (`README.ja.md`, `CONTRIBUTING.ja.md`, `SECURITY.ja.md`, `CODE_OF_CONDUCT.ja.md`), kept section for section and cross-linked at the top
- **Documentation writes no control-protocol parameter number and no raw value.** It names an item the way the unit's screen, its user guide or the command's own help names it
- **This repository is public.** Raw device evidence, real device identifiers, private research notes and links to private material stay out of it — source, comments, documentation, commit messages and pull request bodies alike

## Versioning

- The root `package.json` `version` is the CLI's version and its only hand-edited copy; it is independent of the urx-device version. `pnpm version:write` regenerates `native/Cargo.toml` and its `Cargo.lock` entry, and CI fails on drift
- Build tools are pinned: Node in `.node-version`, pnpm in `packageManager` and Rust in `rust-toolchain.toml`, all recorded in `build-inputs.json`. The napi crates are pinned with `=` and the napi CLI exactly; napi and napi-derive move together, since the code napi-derive generates calls into napi. No step resolves a floating `latest`
- The addon and the JavaScript are two halves of one build. The addon reports its bridge revision and the urx-device version and commit it was built from; the CLI refuses device access unless they match its own (`src/bridge.ts`, `dist/build-info.js`), and a side that cannot name its commit or version does not match
- `pnpm build:release` builds both halves from the recorded commits, never from the working tree. It exports HEAD, with `vendor/urx-device` at the commit the gitlink pins, into a temporary worktree, builds there with `--release` and copies the result to `dist-release/`. With `--release`, `scripts/build-info.mjs` and `scripts/build-native.mjs` refuse a checkout whose `vendor/urx-device` is not at the pinned gitlink, whose CLI or urx-device has staged or unstaged changes to tracked files, or whose versions are unknown. A development build embeds whatever it was built from

## Repository checks

- The `main` ruleset requires the contexts listed in `.github/required-checks.json`. A workflow change keeps every pull-request workflow triggering unfiltered, keeps each gate an `if: always()` job that reads `needs.*.result`, and updates that file and the ruleset together
- Every job, and every step that fetches from outside GitHub, carries a `timeout-minutes`; third-party actions are pinned to a 40-character SHA with a version comment; nothing in CI writes to a pull request's branch

## Conventions

- Commits and pull request titles follow Conventional Commits
- A pull request body follows `.github/PULL_REQUEST_TEMPLATE.md`; `gh pr create --body` replaces the template, so reproduce its sections
- Identifiers and comments in English. Comments describe behavior, not history
- Retain the MIT copyright and permission notice on code moved from urx-router
