# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

## [1.0.0] - unreleased

First stable release. Includes everything below that was planned as 0.2.0 (never published).

### Added

- Refine with `/w+ <change>`: changes this terminal's last command (or your edited version of it), up to 5 times, with the last exit status for "fix that". Direct mode asks `[r]un, re[f]ine, [q]uit?`.
- Web lookup through [tiny-browse](https://github.com/shubhamcodess/tiny-browse), now a regular dependency (`@shubhamcodess/tiny-browse`, used as a library in the same process). On by default, but only for a request the local model got wrong: it answered `SEARCH: …`, or its answer still fails after the retries. Requests it gets right never touch the network. At most one lookup per request.
  - Known reference pages (kubectl, helm, gcloud, az, gh, kind, kustomize, istioctl, argocd, eksctl) are read over plain HTTP, without Chrome or a search engine, and cached for 7 days.
  - Rate limits: tiny-browse's shared per-engine budgets and your tiny-browse config apply; a blocked search is never retried, and when every engine refuses whatcmd pauses its searches for 15 minutes (`web search paused`).
  - `/w+` refinements reuse the web docs of the command they change instead of searching again.
  - `--web` / `--no-web`, `WHATCMD_WEB`, `webTimeoutMs` (default 15 s). `whatcmd doctor` shows tiny-browse's checks (browser, engine budgets) and any pause.
- Shell shortcut: a spinner right after the typed request while whatcmd works (ASCII when the locale isn't UTF-8; Ctrl-C stops it). When nothing was generated, the next Enter on the unchanged line clears it so you can type again.
- `whatcmd doctor` rewrites an installed hook file, so upgrades pick up hook changes.
- `benchmarks/cases/17-cloud-cli.jsonl` (40 kubectl, helm, gcloud, docker, kind, kustomize and gh cases), harness config D (web on), and `npm run eval:web` for a quick before/after.

### Changed

- Requires Node.js 22 or newer (tiny-browse needs it; Node 21 is end of life).
- `web` defaults to `true`. Set `whatcmd config set web false` to stay fully local.

### Removed

- `webCommand` setting: tiny-browse is no longer started as a separate MCP server process.

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

[Unreleased]: https://github.com/shubhamcodess/whatcmd/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/shubhamcodess/whatcmd/releases/tag/v1.0.0
[0.1.0]: https://github.com/shubhamcodess/whatcmd/releases/tag/v0.1.0
