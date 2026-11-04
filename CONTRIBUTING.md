# Contributing to whatcmd

Thanks for helping. whatcmd is a small project with one job: turn a plain-English request into a shell command that the user checks before running. Changes should keep that promise: nothing runs by itself, dangerous commands get a warning, and non-shell requests produce nothing.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Ways to help

- **Report a bug.** Open an issue with the request you typed, the command you got, what you expected, and the output of `whatcmd doctor` and `whatcmd --debug --raw -- <request>`. Remove anything private (paths, hostnames) first.
- **Suggest a feature.** Open an issue that explains the problem before the solution. Changes to the prompt, the gate or the shell hook affect every user, so we discuss those first.
- **Add eval cases.** A request the model gets wrong is valuable. Add it to `eval/cases.json` with the regular expression a correct command must match.
- **Improve the docs.** Fix anything that is wrong or unclear.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

```bash
git clone https://github.com/shubhamcodess/cmdkit whatcmd
cd whatcmd
npm ci
npm test
```

You need Node.js 21 or newer. For `npm run eval` you also need [Ollama](https://ollama.com) running locally with `qwen2.5-coder:1.5b` downloaded.

## Making a change

1. **Create a branch** from `main`. Use a short, descriptive name, for example `fix/echo-pipe-gate` or `docs/readme`.
2. **Keep the change small.** One fix or one feature per pull request.
3. **Add a test** for each bug fix. It should fail before the fix and pass after it. See [TESTING.md](TESTING.md).
4. **Run the checks:**
   ```bash
   npm test
   npm run eval      # required if you touch prompts, the gate, retries or grounding
   ```
5. **Record eval numbers** in the pull request description when your change could affect accuracy: the numbers before and after, and the model used.
6. **Update the docs** you affect, for example `README.md`, `EVALS.md`, or `CHANGELOG.md` under "Unreleased".

## Code style

- TypeScript with `strict` mode. Keep the code in `src/`; the built files in `dist/` are not committed.
- Prefer plain functions and small modules. The gate, the risk checks and the config are separate on purpose.
- Keep dependencies to a minimum. Adding a runtime dependency needs a reason in the pull request.
- Comments explain *why*, not *what*. Error messages must say what the user can do next.
- Output that the user reads on the prompt must stay short and must not contain secrets or private paths.

## Rules that keep the product safe

- **Never let the model run a command.** The output is text on the prompt. Only the user presses Enter.
- **Do not weaken the gate** (`src/gate.ts`) to get a case to pass. Fix the prompt or the retry logic, or explain why the case is wrong.
- **Do not change the expected results in the benchmark** (`benchmarks/cases/`) to make a failing case pass. If an expectation is wrong, say so in the pull request and explain what is wrong with it.
- **Keep the warnings.** Removing a risk warning needs a strong reason and a test.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run eval` numbers are in the description, if the change could affect accuracy.
- [ ] New behaviour has a test, and bug fixes have a regression test.
- [ ] Docs and `CHANGELOG.md` are updated where needed.
- [ ] No secrets, personal paths or real credentials in code, tests, logs or examples.

## Releases (maintainers)

The package is published to npm as **`@shubhamcodess/whatcmd`**. The scope is part of the name; the commands it installs are `whatcmd`.

**How a release happens**

1. Open a pull request into `main`. CI runs: unit tests on Linux and macOS with Node 21, the Markdown link check, the package check, and an install of the tarball.
2. Before merging, update `CHANGELOG.md`: move the items under `[Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section. Bump `version` in `package.json` in the same pull request.
3. Merge the pull request. The **Release** workflow runs on `main`:
   - If the tag `vX.Y.Z` does not exist yet, it runs the tests and the package check, then publishes to npm with provenance (only if the `NPM_TOKEN` secret exists), then installs the published version from the registry and runs it.
   - It creates the tag `vX.Y.Z` and a GitHub release. The release notes are the CHANGELOG section for that version, and the tarball is attached.
   - A merge that does not change the version does nothing.

If the `NPM_TOKEN` secret is missing, the GitHub release is still created, with a note that the package is not on npm. Add the secret and run the **Release** workflow by hand (Actions, Release, Run workflow) to publish that version later.

**One-time setup for npm**

1. The scope `@shubhamcodess` must exist on npm (a user or organisation with that name).
2. On npmjs.com create a **granular access token**: read and write for the package or scope, expiry at most one year, and "Bypass two-factor authentication" enabled (CI cannot type a one-time code).
3. Save it as the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions). Provenance uses the workflow's identity, so no other secret is needed.

**If a bad version goes out**

- Do not reuse a version number. Publish a fixed patch release.
- Deprecate the bad version: `npm deprecate "@shubhamcodess/whatcmd@X.Y.Z" "reason; use X.Y.Z+1"`.
- If the npm token leaked, revoke it on npmjs.com first, create a new one, and update `NPM_TOKEN`.

**GitHub Pages (landing page, later)**

The Pages workflow does nothing until a `site/` folder with a `package.json` exists. When you add the landing page, set Settings, Pages, Source to "GitHub Actions" once.

## Review

A maintainer reviews every pull request. Expect questions about safety first, then about accuracy and style. Please reply to comments in the pull request rather than in private messages, so others can follow the discussion.

## Licence

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
