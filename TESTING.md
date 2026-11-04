# Testing

whatcmd has two kinds of checks:

| Check | Command | Needs Ollama? | What it proves |
| --- | --- | --- | --- |
| **Unit tests** | `npm test` | No | The gate, risk warnings, config, grounding helpers and shell-hook helpers behave as specified. |
| **Eval** | `npm run eval` | Yes | The real model gives correct commands, blocks non-shell requests, and answers in a reasonable time. |

The full 500-case benchmark is a separate, larger check. See [EVALS.md](EVALS.md).

## Unit tests

```bash
npm ci
npm test
```

`npm test` builds the project with TypeScript, then runs the compiled test files with Node's built-in test runner. It needs no network and no model, so it is fast and safe to run anywhere.

Expected result on the current `main` candidate:

```text
# tests 30
# pass 30
# fail 0
```

### What the tests cover

| File | Area |
| --- | --- |
| `src/gate.test.ts` | Gate and risk: extracting the command from model output, splitting pipelines and quotes, finding the real program behind `sudo`, `env` and `nohup`, rejecting `NONE` and chat replies, missing programs, and risk warnings. |
| `src/misc.test.ts` | Config (host normalisation, set/unset, environment overrides), the system profile text, grounding candidates and excerpts, the prompt layout, the shell hook text, and install and uninstall of the hook. |
| `src/fixes.test.ts` | Regression tests for the fixes made during benchmarking: wrapper options such as `nice -n`, the escaped pipe `echo a \| b`, `chmod 666` and `sh -c "$(curl …)"` warnings, a number never being a program name, macOS `sed -i ''`, the second-chance trigger, echoed and copied answers, calculator and injection answers, and bash older than 4. |

### Adding a test

- Put the test next to the code it covers, as `src/<name>.test.ts`.
- Use `node:test` and `node:assert/strict`, the same as the existing files.
- A bug fix should come with a test that fails before the fix and passes after it.
- Do not weaken an existing assertion to make a failing test pass. If an assertion is wrong, explain why in the pull request.

## Eval

```bash
npm run eval                              # default model and settings
npm run eval -- --model=qwen2.5-coder:0.5b
npm run eval -- --no-grounding            # turn off reading local docs
VERBOSE=1 npm run eval                    # print every answer, not only failures
```

The eval needs Ollama running and the model downloaded (`whatcmd use <model>`). It runs the cases in `eval/cases.json` one at a time and prints:

- how many valid requests got a correct command,
- how many non-shell requests were blocked,
- latency p50, p90 and max.

A `FAIL` line shows the request, the command it got, and why it failed. A `LEAK` line means a non-shell request produced a command.

The eval is a quick regression check, not a measurement of accuracy in general. For a fuller picture, see [EVALS.md](EVALS.md).

## Shell hook

The unit tests and the eval do not drive a real shell. The hook was checked separately by driving interactive zsh sessions through a pseudo-terminal. The 10 scenarios (prefill, second Enter runs, special characters, rejection, normal commands unaffected, custom prefix, risk warning, no substitution, empty request, Ollama down) are described in [benchmarks/README.md](benchmarks/README.md). The bash scenarios need bash 4 or newer.

## Benchmark

```bash
# see benchmarks/README.md for the required folder layout
node harness/validate-cases.mjs --final
node harness/run.mjs --config=A --model=qwen2.5-coder:1.5b --grounding=on
```

The harness and the cases are in [`benchmarks/`](benchmarks/README.md).

## Before you open a pull request

```bash
npm test
npm run eval            # if your change touches the model prompt, gate or retries
```

Record the eval numbers before and after your change in the pull request description.
