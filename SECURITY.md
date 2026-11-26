# Security Policy

> 日本語版は [SECURITY.ja.md](SECURITY.ja.md) を参照してください.

urx-cli is a command line tool. It has no server component, no account system and no telemetry. Its only network access is the connection to Device Center on the same computer, made when a command needs the device.

## Supported versions

Only the latest release is supported. Fixes ship as a new release rather than as a backport.

## Reporting a vulnerability

Report it privately through GitHub —
**[Security → Report a vulnerability](https://github.com/semnil/urx-cli/security/advisories/new)**.
Please do not open a public issue for a security problem.

Helpful details: the output of `urx --version`, what an attacker gains, and the steps to reproduce it. Attach any file needed to reproduce rather than pasting device values into the report.

This is a single-maintainer project, so handling is best effort: expect a first reply within about a week. You will be credited in the advisory unless you prefer otherwise.

## In scope

- Code execution, memory corruption or unbounded resource use reachable from data the tool reads: its arguments, a command file, a settings file, standard input, or a message received from the Device Center connection
- Connections to anything other than Device Center on the same computer
- Installation that lets another user change what the command runs
- Secrets or signing material exposed in the repository, in CI or in a release

## Out of scope

- **Writes to the device.** Changing the connected unit's settings is what the tool is for, not a flaw.
- Driving hardware over a control protocol determined by independent analysis, as such
- Vulnerabilities in the device firmware, in the units themselves, or in Yamaha's software — report those to Yamaha
- Findings that require an attacker who already executes code as your user
- Scanner output with no demonstrated impact
