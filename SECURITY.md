# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (current pre-release) | Yes |
| anything older | No (there is no older release) |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

<https://github.com/shubhamcodess/cmdkit/security/advisories/new>

Please include:

- What you ran (the request, the command whatcmd produced, and the shell).
- What happened, and what you expected.
- Your macOS or Linux version, Node version, and `whatcmd --version`.
- Whether the problem needs a specific model, config value or environment variable.

Remove private paths, hostnames, tokens and personal data before you send the report.

### What to expect

- An acknowledgement within a few working days.
- An assessment of severity and whether it can be reproduced.
- A fix, or a clear explanation of why it is not a vulnerability.
- Credit in the release notes, if you want it.

We ask that you give us a reasonable time to fix the problem before you publish details.

## Threat model

whatcmd is designed so that a model's output cannot run on its own:

- **Commands are text on your prompt.** The shell hook replaces your line; only you press Enter. The `whatcmd <request>` command asks before running anything, and `--raw` only prints.
- **Requests are not interpolated.** The shell hook passes your line to whatcmd as a quoted argument, so `$(…)` and backticks in your request are not executed by the shell.
- **Risk warnings.** Commands that delete recursively, format disks, change permissions broadly, force-push, pipe downloads into a shell, or run as root get a warning. Warnings are a safety aid, not a guarantee.
- **The model runs locally.** whatcmd talks to the Ollama server at the configured `host` (default `127.0.0.1:11434`). It does not send your requests to other services.
- **Files it writes:** the config file (`~/.config/whatcmd/config.json` by default), a cache of local tool documentation, and the shell rc file's marked block when you run `init`. `uninstall` removes the block.

Things that are **not** protected:

- A model can give a wrong command that does not match any warning. Read the command before you press Enter.
- Anything you paste into the prompt line runs with your user's rights.
- The shell hook rebinds Enter in bash and wraps `accept-line` in zsh. Other tools that do the same can interfere.

## Dependencies

whatcmd has no runtime dependencies beyond Node.js and Ollama. Build-time dependencies are TypeScript and Node type definitions. Run `npm audit` on your checkout to check the lockfile.
