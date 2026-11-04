# whatcmd

**Type plain English at your shell prompt, get a real command back.**

whatcmd runs a small language model **on your own machine** through [Ollama](https://ollama.com). No API keys, no accounts, and your requests never leave your computer.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)
![Status](https://img.shields.io/badge/status-0.1.0%20pre--release-orange)

```text
$ /w find files bigger than 100MB            ← press Enter
$ find . -type f -size +100M                 ← your line is replaced; press Enter again to run it
```

## Why

Most of the time you know what you want to do but not the exact flags. whatcmd turns the request into one command, puts it on your prompt, and lets you decide.

- **It never runs anything by itself.** The command appears on your prompt. You read it, edit it, or press Enter.
- **It knows your system.** It detects your OS, distro, shell, package manager and installed tools, so it writes BSD flags on macOS (`sed -i ''`, `stat -f`) and avoids tools you don't have.
- **It reads your docs.** If your request names an installed program (`jq`, `ffmpeg`, `lsof`, …) or a package, it reads that tool's man page or `--help` and gives the relevant lines to the model.
- **It stays quiet when it should.** "tell me a joke" or "what is the capital of France" produce nothing.
- **It warns before you hurt yourself.** `rm -r`, `dd`, `mkfs`, `curl | sh`, `git push --force`, `chmod 777` and placeholders like `/path/to/…` are flagged on your prompt.

## Install

> Requires Node.js 18.17 or newer and macOS or Linux (bash or zsh for the shortcut).

Once version 0.1.0 is on npm (the release workflow publishes it on merge to `main`):

```bash
npm install -g @shubhamcodess/whatcmd
whatcmd init
```

Before that, install from source:

```bash
git clone https://github.com/shubhamcodess/cmdkit whatcmd
cd whatcmd
npm ci
npm run build
npm install -g .          # puts the `whatcmd` command on your PATH
whatcmd init
```

`whatcmd init` walks you through setup:

1. Detects your system and saves it to your profile.
2. Checks Ollama. If it's missing, it shows the install command for your OS and offers to run it. If it's installed but stopped, it offers to start it.
3. Lets you pick a model (recommended ones, any model you already have, or any name from the [Ollama library](https://ollama.com/library)) and downloads it.
4. Runs a test request and shows how fast it is.
5. Adds the `/w` shortcut to your `~/.zshrc` (or `~/.bashrc`).

Open a new terminal and type `/w <request>`. Any shell can use `whatcmd <request>` directly.

## Use

| You type | What happens |
| --- | --- |
| `/w <request>` then Enter | Your line is replaced by the command. Press Enter again to run it. |
| `whatcmd <request>` | Prints the command and asks "Run it? [y/N]". |
| `whatcmd --raw -- <request>` | Prints only the command, for scripts. Exit code `2` if the request isn't a shell task. |

Quotes are not needed, even with `'`, `>` or `*` in the request: the shortcut reads your line before the shell parses it.

```bash
whatcmd "what's using port 8080"
whatcmd --raw -- list the 5 biggest folders in this directory
```

## Commands

```text
whatcmd init                 first-time setup
whatcmd doctor               check Ollama, model, speed and shortcut; offers fixes
whatcmd use <model>          switch model (downloads it if needed)
whatcmd models               list downloaded models
whatcmd config               show settings
whatcmd config set <key> <value> | get <key> | unset <key> | path | reset
whatcmd profile [--refresh]  show (or re-detect) the system info given to the model
whatcmd shell bash|zsh       print the shell hook, to add it yourself
whatcmd uninstall            remove the shortcut from your shell config
```

Flags: `--debug` (grounding, prompts and timings), `--model=NAME` (one request with another model), `--yes` (non-interactive `init` and `doctor`), `--raw` (command only).

## Settings

Stored in `~/.config/whatcmd/config.json`. Run `whatcmd config` to see the effective values.

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `qwen2.5-coder:1.5b` | Any Ollama model. |
| `host` | `http://127.0.0.1:11434` | Ollama server. Also reads `OLLAMA_HOST`. |
| `prefix` | `/w` | What you type before a request, e.g. `config set prefix ,`. |
| `grounding` | `true` | Read local docs of the tools you mention. |
| `notes` | *(empty)* | Extra instructions, e.g. `"prefer ripgrep over grep"`. |
| `keepAlive` | `2h` | How long Ollama keeps the model loaded (`-1` = forever). |
| `temperature` | `0` | Keep at `0` for repeatable answers. |
| `timeoutMs` | `30000` | Time limit for one model call. |

Environment variables override the file: `WHATCMD_MODEL`, `WHATCMD_HOST`, `WHATCMD_CONFIG_DIR`, `WHATCMD_CACHE_DIR`. `NO_COLOR` turns off colours.

## Measurements

All numbers below come from the benchmark and eval runs described in [EVALS.md](EVALS.md). Hardware: Apple M4 Pro, 14 cores, 48 GB RAM, macOS 15.6.1, Node 22.16, Ollama 0.40.14, zsh 5.9. The final benchmark ran on commit `47e6b47`.

**Accuracy: 500-case benchmark, config A (`qwen2.5-coder:1.5b`, grounding on)**

| Area | Result | Target |
| --- | --- | --- |
| Overall | **92.7%** (454 / 490 scored) | — |
| Generation (plain-English → command) | **84.7%** (127 / 150) | 85% (one case short) |
| Refusal (non-shell requests produce nothing) | **98.8%** (79 / 80) | 93.8% |
| Grounding, invented flags on fake tools | 85% (17 / 20) | — |
| Grounding, real installed tools | 90% (27 / 30) | — |
| Risk warnings (model + deterministic) | 95% (38 / 40) | — |
| Missing tools (named tool not installed) | 100% (30 / 30) | — |
| Gate, risk, config and CLI unit-style checks | 100% (60 / 60, 30 / 30, 20 / 20) | — |
| Shell hook, zsh (10 scenarios) | 10 / 10 | — |

**Other sizes, same run**

| Config | Model | Grounding | Result |
| --- | --- | --- | --- |
| A | qwen2.5-coder:1.5b (default) | on | 92.7% overall, all 500 cases |
| B | qwen2.5-coder:1.5b | off | 77.7% of model cases (grounding cases cannot pass without docs) |
| C | qwen2.5-coder:0.5b | on | 68% of model cases; generation 66% |

**Eval (`npm run eval`, 83 requests, same model and commit)**

- Valid requests answered correctly: **35 / 48**.
- Non-shell requests blocked: **34 / 35**.
- Latency p50 105 ms, p90 218 ms, max 645 ms.

**Speed (config A, benchmark run)**

| Measure | Value |
| --- | --- |
| Model call, p50 / p90 / p99 | 121 ms / 422 ms / 739 ms |
| Whole command end-to-end (`whatcmd --raw`), p50 / p90 | 217 ms / 330 ms |
| First request after the model unloads | about 0.8 s |
| Repeatability: 50 random cases run 3 times | 50 / 50 gave identical output |

Numbers vary with hardware, model, and whether the model is already loaded.

## How it works

```text
request ─► grounding ─► local model ─► gate ─► your prompt line
           man / --help    system profile     NONE? not a command?
           package db      + examples         not installed? → retry once
                                              risky? → warning
```

1. **Profile.** OS, distro, shell, package manager, GNU/BSD/BusyBox userland, and which common tools are installed. Detected once and stored.
2. **Grounding.** Words in your request that name an installed program or system package pull in that tool's usage and matching option lines. The man page is read first, `--help` is the fallback, and dangerous programs are never run with `--help`. Results are cached per binary version.
3. **Generation.** The model gets the profile, a few examples and the docs. It must answer with one command or `NONE`.
4. **Gate.** Output is dropped when it is `NONE`, doesn't parse as shell, is chat text, repeats the request, copies an example, or loops.
5. **Retries (at most 3 model calls).**
   - **Second chance:** a request that is clearly about the computer (files, git, ports, docker, paths…) gets one more attempt with a prompt that has no `NONE` option. Arithmetic, text and prompt-injection answers are still filtered out.
   - **Fix-up:** if the command uses a program that isn't installed, GNU-only flags on macOS, or repeats the request, the model gets one specific hint. For example: "on macOS use `vm_stat` instead of `free`".
   - **Auto-fix:** on macOS, `sed -i 's/…'` becomes `sed -i '' 's/…'`.

## Known limits

- **Small models make mistakes.** The eval and the benchmark both show wrong flags, wrong tools and dropped filters. Read every command before you press Enter.
- **Generation is just under target.** 84.7% against an 85% goal on the 500-case benchmark. Measured, not fixed.
- **Only zsh was verified end to end.** The bash shortcut needs bash 4 or newer. macOS ships bash 3.2, so on a Mac use zsh (the default) or `brew install bash`. `whatcmd init` detects the old bash and says so. The bash hook scenarios were skipped in the benchmark.
- **Benchmarks ran on one machine** (Apple Silicon, macOS 15.6.1, Ollama 0.40.14). Linux is supported by design but not covered by the benchmark.
- **Slow first `--help` calls** can time out, and then that tool gets no docs for that request. Later calls work. The benchmark's kubectl case hit this once.
- **Math and text requests** can still come back as `bc` or `echo` commands in some cases.
- **Conflicts:** the shortcut rebinds Enter in bash (via `bind`) and wraps `accept-line` in zsh. It may conflict with tools that do the same, such as ble.sh.
- **No shortcut yet** for fish or Windows shells. Use `whatcmd <request>`.
- **Homebrew packages** are not looked up in the package database (too slow per request). Installed commands are still read via man page or `--help`.

## Documentation

| File | What it covers |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, test and send a change. |
| [TESTING.md](TESTING.md) | Unit tests, what they cover, and how to run them. |
| [EVALS.md](EVALS.md) | The eval and the 500-case benchmark: design, results, and how to reproduce. |
| [benchmarks/README.md](benchmarks/README.md) | The raw benchmark files: cases, harness, results per run. |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release. |
| [SECURITY.md](SECURITY.md) | Supported versions and how to report a vulnerability. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Expected behaviour in this project. |
| [LICENSE](LICENSE) | MIT. |

## Development

```bash
npm ci
npm test          # build + 30 unit tests
npm run eval      # end-to-end eval against your local Ollama
npm run eval -- --model=qwen2.5-coder:0.5b --no-grounding
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## License

MIT. See [LICENSE](LICENSE).
