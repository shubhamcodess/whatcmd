# whatcmd

Type plain English at your shell prompt, get a real command back. Runs **locally** on [Ollama](https://ollama.com): no API keys, nothing leaves your machine.

```text
$ /w find files bigger than 100MB          ← press Enter
$ find . -type f -size +100M                    ← your line is replaced; Enter again runs it
```

- **Never runs anything by itself.** The command lands on your prompt; you check it, edit it, or press Enter.
- **Knows your system.** It detects your OS, distro, shell, package manager and which tools are installed, so it writes `brew`/BSD flags on macOS and avoids tools you don't have.
- **Grounded in your docs.** If you mention a tool or package that is installed (`jq`, `ffmpeg`, `lsof`, …), it reads that tool's local man page or `--help` (or the package database) and gives the relevant lines to the model.
- **Says nothing when it should.** "tell me a joke" or "what is the capital of France" generate nothing.
- **Warns before you hurt yourself:** `rm -r`, `dd`, `mkfs`, `curl | sh`, `git push --force`, placeholders like `/path/to/…`.

## Install

```bash
npm install -g whatcmd
whatcmd init
```

`whatcmd init` walks you through setup:

1. Detects your system and saves it to your profile.
2. Checks Ollama. If it's missing, it shows the install command for your OS and offers to run it. If Ollama is installed but stopped, it offers to start it.
3. Lets you pick a model (recommended ones below, any model you already have, or any name from the [Ollama library](https://ollama.com/library)) and downloads it.
4. Runs a test request and shows how fast it is.
5. Adds the `/w` shortcut to your `~/.bashrc` or `~/.zshrc`.

Open a new terminal and you're done. Requirements: Node 18+, Linux or macOS, bash or zsh for the shortcut. Any shell can use `whatcmd <request>`.

## Use

| You type | What happens |
| --- | --- |
| `/w <request>` + Enter | Your line is replaced by the command. Enter again runs it. |
| `whatcmd <request>` | Prints the command and asks "Run it? [y/N]". |
| `whatcmd --raw <request>` | Prints only the command (for scripts). Exit code 2 if it isn't a shell task. |

Quotes are not needed, even with `'`, `>` or `*` in your request: the shortcut reads the line before the shell parses it.

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

Flags: `--debug` (show grounding, prompts and timings), `--model=NAME` (one request with another model), `--yes` (non-interactive `init`/`doctor`).

## Settings

Stored in `~/.config/whatcmd/config.json`.

| Key | Default | |
| --- | --- | --- |
| `model` | `qwen2.5-coder:1.5b` | any Ollama model |
| `host` | `http://127.0.0.1:11434` | Ollama server; also reads `OLLAMA_HOST` |
| `prefix` | `/w` | what you type before a request, e.g. `config set prefix ,` |
| `grounding` | `true` | read local docs of tools you mention |
| `notes` | | extra instructions, e.g. `"prefer ripgrep over grep"` |
| `keepAlive` | `2h` | how long Ollama keeps the model loaded (`-1` = forever, fastest) |
| `temperature` | `0` | |
| `timeoutMs` | `30000` | |

Environment variables override the file: `WHATCMD_MODEL`, `WHATCMD_HOST`, `WHATCMD_CONFIG_DIR`, `NO_COLOR`.

## Models

500-case benchmark on an Apple M4 Pro (macOS 15, Ollama 0.40, whatcmd 0.1.0 before the fixes listed below):

| Model | Overall | Commands correct | Non-shell blocked | Typical time | CLI end-to-end |
| --- | --- | --- | --- | --- | --- |
| `qwen2.5-coder:1.5b` (default) | 85% | 74% | 94% | ~110 ms | ~230 ms |
| `qwen2.5-coder:0.5b` | 62% | 55% | 98% | ~70 ms | |

First request after the model unloads: ~0.8 s. Repeated runs give the same answer (50/50 cases identical over 3 runs).

On the 72-request regression set (`npm run eval`, 4-core CPU without GPU), the fixes made after that benchmark raised `qwen2.5-coder:1.5b` from 28/42 to 41/48 correct (6 cases added later) and blocked 35/35 non-shell requests. `whatcmd --debug` shows why each word in the request did or didn't get documentation.

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
4. **Gate.** Output is dropped when it is `NONE`, doesn't parse as shell, is chat text, repeats the request, copies an example, or loops (`photos photos photos …`). Arithmetic or literal text piped through `bc`/`tr` (`echo "60/1.5" | bc`) also counts as answering a question, unless you mention the shell. Prompt injections ("ignore the system prompt and …") are refused outright.
5. **Retries (at most 3 model calls).**
   - **Second chance:** if the model says `NONE` to a request that is clearly about the computer (it mentions files, git, ports, docker, a filename, a path…), it is asked once more with a prompt that has no `NONE` option. The trigger list is deliberately narrow, and arithmetic, text or injection answers are still filtered out, so real non-shell questions produce nothing.
   - **Fix-up:** if the command uses a program that isn't installed, uses GNU-only flags on macOS (`date -d`, `stat -c`, `grep -P`…), or repeats the request, the model gets one retry with a specific hint. For example: "on macOS use `vm_stat` instead of `free`". Anything still wrong is shown with a warning.
   - **Auto-fix:** on macOS, `sed -i 's/…'` is rewritten to `sed -i '' 's/…'`.

## Known limits

- Small models still make mistakes. In the eval they wrote `fuser -t 8080` instead of `lsof -i :8080` and `ls | sort` for "biggest directories". On macOS they still sometimes pick Linux tools; when a tool is missing you get a warning. Read the command before pressing Enter. That is why it never runs by itself.
- The shortcut rebinds Enter in bash (via `bind`) and wraps `accept-line` in zsh. It may conflict with other tools that do the same (e.g. ble.sh).
- The bash shortcut needs bash 4 or newer. macOS ships bash 3.2, so on a Mac use zsh (the default) or `brew install bash`. `whatcmd init` detects this and says so.
- Math and translation requests can slip through as `bc` or `echo` commands. The shell really can do the math, so this is a judgment call.
- fish and Windows shells: use `whatcmd <request>`. There is no shortcut yet.
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
