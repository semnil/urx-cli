# AGENTS.md — urx-cli

## Overview

The `urx` command line tool for the YAMAHA URX22 / URX44 / URX44V: one-shot reads and writes, watches, command files, an interactive console and settings-file import. It consumes the shared library [urx-device](https://github.com/semnil/urx-device) as a pinned Git submodule at `vendor/urx-device`: device definitions, semantic operations and the Device Center transport live there, not here.

## Structure

- `src/` — the command: argument grammar, help and version, terminal and JSON output, exit codes, process lifecycle. `src/cli/commands.ts` is the command-binding table that the parser and help both read
- `vendor/urx-device/` — the shared library at the adopted commit. Never edited here
- `scripts/` — repository tooling: `build-inputs.mjs` (checks the build inputs) and `build-info.mjs` (writes `dist/build-info.js`, the versions and commits that `urx --version` shows)
- `build-inputs.json` — the exact Node and pnpm versions and Node archive hashes a build uses, the one record of them
- `.github/required-checks.json` — the status checks the `main` ruleset requires, the only copy outside GitHub's settings

## Development

```sh
git submodule update --init
pnpm install --frozen-lockfile
pnpm build-inputs:check   # build-inputs.json agrees with .node-version and package.json
pnpm typecheck            # source config and test config
pnpm build                # tsc emit of src/ into dist/, then dist/build-info.js from the checkout
pnpm test                 # vitest: src/**/*.test.ts, test/**/*.test.ts and scripts/**/*.test.mjs
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

- The root `package.json` `version` is the CLI's version and its only hand-edited copy; it is independent of the urx-device version
- Build tools are pinned: Node in `.node-version`, pnpm in `packageManager`, both recorded with their hashes in `build-inputs.json`. No step resolves a floating `latest`

## Repository checks

- The `main` ruleset requires the contexts listed in `.github/required-checks.json`. A workflow change keeps every pull-request workflow triggering unfiltered, keeps each gate an `if: always()` job that reads `needs.*.result`, and updates that file and the ruleset together
- Every job, and every step that fetches from outside GitHub, carries a `timeout-minutes`; third-party actions are pinned to a 40-character SHA with a version comment; nothing in CI writes to a pull request's branch

## Conventions

- Commits and pull request titles follow Conventional Commits
- A pull request body follows `.github/PULL_REQUEST_TEMPLATE.md`; `gh pr create --body` replaces the template, so reproduce its sections
- Identifiers and comments in English. Comments describe behavior, not history
- Retain the MIT copyright and permission notice on code moved from urx-router
