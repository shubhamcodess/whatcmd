# cmdkit

Type plain English at your shell prompt, get a real command back. Runs **locally** on [Ollama](https://ollama.com): no API keys, nothing leaves your machine.

```text
$ /cmdkit find files bigger than 100MB          ← press Enter
$ find . -type f -size +100M                    ← your line is replaced; Enter again runs it
```

- **Never runs anything by itself.** The command lands on your prompt; you check it, edit it, or press Enter.
- **Knows your system.** It detects your OS, distro, shell, package manager and which tools are installed, so it writes `brew`/BSD flags on macOS and avoids tools you don't have.
- **Grounded in your docs.** If you mention a tool or package that is installed (`jq`, `ffmpeg`, `lsof`, …), it reads that tool's local man page or `--help` (or the package database) and gives the relevant lines to the model.
- **Says nothing when it should.** "tell me a joke" or "what is the capital of France" generate nothing.
- **Warns before you hurt yourself:** `rm -r`, `dd`, `mkfs`, `curl | sh`, `git push --force`, placeholders like `/path/to/…`.

## Install

```bash
npm install -g @shubhamcodess/cmdkit
cmdkit init
```

`cmdkit init` walks you through setup:

1. Detects your system and saves it to your profile.
2. Checks Ollama. If it's missing, it shows the install command for your OS and offers to run it. If Ollama is installed but stopped, it offers to start it.
3. Lets you pick a model (recommended ones below, any model you already have, or any name from the [Ollama library](https://ollama.com/library)) and downloads it.
4. Runs a test request and shows how fast it is.
5. Adds the `/cmdkit` shortcut to your `~/.bashrc` or `~/.zshrc`.

Open a new terminal and you're done. Requirements: Node 18+, Linux or macOS, bash or zsh for the shortcut. Any shell can use `cmdkit <request>`.

## Use

| You type | What happens |
| --- | --- |
| `/cmdkit <request>` + Enter | Your line is replaced by the command. Enter again runs it. |
| `cmdkit <request>` | Prints the command and asks "Run it? [y/N]". |
| `cmdkit --raw <request>` | Prints only the command (for scripts). Exit code 2 if it isn't a shell task. |

Quotes are not needed, even with `'`, `>` or `*` in your request: the shortcut reads the line before the shell parses it.

## Commands

```text
cmdkit init                 first-time setup
cmdkit doctor               check Ollama, model, speed and shortcut; offers fixes
cmdkit use <model>          switch model (downloads it if needed)
cmdkit models               list downloaded models
cmdkit config               show settings
cmdkit config set <key> <value> | get <key> | unset <key> | path | reset
cmdkit profile [--refresh]  show (or re-detect) the system info given to the model
cmdkit shell bash|zsh       print the shell hook, to add it yourself
cmdkit uninstall            remove the shortcut from your shell config
```

Flags: `--debug` (show grounding, prompts and timings), `--model=NAME` (one request with another model), `--yes` (non-interactive `init`/`doctor`).

## Settings

Stored in `~/.config/cmdkit/config.json`.

| Key | Default | |
| --- | --- | --- |
| `model` | `qwen2.5-coder:1.5b` | any Ollama model |
| `host` | `http://127.0.0.1:11434` | Ollama server; also reads `OLLAMA_HOST` |
| `prefix` | `/cmdkit` | what you type before a request, e.g. `config set prefix ,` |
| `grounding` | `true` | read local docs of tools you mention |
| `notes` | | extra instructions, e.g. `"prefer ripgrep over grep"` |
| `keepAlive` | `2h` | how long Ollama keeps the model loaded (`-1` = forever, fastest) |
| `temperature` | `0` | |
| `timeoutMs` | `30000` | |

Environment variables override the file: `CMDKIT_MODEL`, `CMDKIT_HOST`, `CMDKIT_CONFIG_DIR`, `NO_COLOR`.

## Models

| Model | Size | Correct | Non-shell blocked | Typical time |
| --- | --- | --- | --- | --- |
| `qwen2.5-coder:1.5b` (default) | 1.0 GB | 21/24 | 15/15 | ~0.5 s |
| `qwen2.5-coder:0.5b` | 0.4 GB | 14/24 | 15/15 | ~0.3 s |

Measured with `npm run eval` on a 4-core CPU with no GPU, model already loaded. A laptop is usually faster, and a GPU much faster. The first request after the model unloads takes 1–3 s.

## How it works

```
request ─► grounding ─► local model ─► gate ─► your prompt line
           man/--help    system profile   NONE? not a command?
           package db    + few-shot       not installed? → retry once
                                          risky? → warning
```

1. **Profile.** OS, distro, shell, package manager, GNU/BSD/BusyBox userland, and which common tools are installed. Detected once and stored.
2. **Grounding.** Words in your request that name an installed program or system package (apt/dnf/pacman/apk) pull in that tool's description, usage line, and the option lines that match your request. The man page is read first; `--help` is the fallback (never for dangerous programs). Results are cached per binary version.
3. **Generation.** A small local model gets the profile, a few examples and the docs. It must answer with one command or `NONE`.
4. **Gate.** Output that is `NONE`, does not parse as shell, or is chat text is dropped. If a program in the command isn't installed, the model gets one retry. If it still uses it, the command is shown with a "not installed" warning.

## Known limits

- Small models still make mistakes. In the eval they wrote `fuser -t 8080` instead of `lsof -i :8080` and `ls | sort` for "biggest directories". Read the command before pressing Enter. That is why it never runs by itself.
- The shortcut rebinds Enter in bash (via `bind`) and wraps `accept-line` in zsh. It may conflict with other tools that do the same (e.g. ble.sh).
- fish and Windows shells: use `cmdkit <request>`. There is no shortcut yet.
- Package-database grounding isn't done for Homebrew (too slow per request); installed commands are still grounded via man/`--help`.

## Development

```bash
npm install
npm test          # build + unit tests
npm run eval      # end-to-end accuracy/latency against your local Ollama
npm run eval -- --model=qwen2.5-coder:0.5b --no-grounding
```

## License

MIT
