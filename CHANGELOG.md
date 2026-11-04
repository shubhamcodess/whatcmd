# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

## [0.1.0] - 2026-11-05

First release candidate, for the initial public version.

### Added

- Requires Node.js 21 or newer.
- Plain-English to shell command, run locally through Ollama.
- `/w <request>` shell shortcut for bash (4 or newer) and zsh. Enter replaces the line with the command; a second Enter runs it.
- `whatcmd <request>` and `whatcmd --raw -- <request>` for the terminal and for scripts.
- System profile: OS, distro, shell, package manager, userland (GNU, BSD, BusyBox) and installed tools, detected once and stored.
- Grounding: the man page or `--help` of an installed tool, or the local package database, is read and the relevant lines are given to the model. Cached per binary version.
- Gate: rejects `NONE`, non-shell output, chat text, repeated requests, copied examples and loops.
- Second chance for requests that are clearly about the computer, without a `NONE` option. Narrow trigger list.
- Fix-up retry for missing tools and GNU-only flags on macOS, with a specific hint.
- Auto-fix for `sed -i` on macOS (`sed -i ''`).
- Risk warnings for recursive deletes, `dd`, `mkfs`, `curl | sh` (including `sh -c "$(curl …)"`), `git push --force`, `chmod 777` and `chmod 666`, `sudo`, reboots, and placeholders.
- Commands: `init`, `doctor`, `use`, `models`, `config`, `profile`, `shell`, `uninstall`.
- `npm test` with 30 unit tests, and `npm run eval` with 83 eval requests.
- Documentation: README, TESTING, EVALS, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, and the benchmark folder.

### Fixed during pre-release benchmarking

- `nice -n 10 gzip` now finds `gzip`, not `10`.
- A bare number is never treated as a program name, so `3 - 2 = 1` is rejected.
- Timeouts are no longer cached as "no docs", and the limits for `--help` are longer.
- `bash` older than 4 is detected, and the bash shortcut is skipped with a message.

### Known limitations

- Generation accuracy on the 500-case benchmark is 84.7%, just under the 85% goal.
- The bash shortcut was not tested on bash 4 or newer.
- Benchmarks ran on one machine (Apple M4 Pro, macOS 15.6.1, Ollama 0.40.14).
- Some expectations in the benchmark are strict; see `benchmarks/CHANGES_TO_TESTS.md`.

[Unreleased]: https://github.com/shubhamcodess/cmdkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shubhamcodess/cmdkit/releases/tag/v0.1.0
