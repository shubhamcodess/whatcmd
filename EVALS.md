# Evals and benchmarks

This page explains how whatcmd's accuracy and speed are measured, what the numbers are, and how to reproduce them.

There are two measurements:

1. **The eval** (`npm run eval`): 83 requests from `eval/cases.json`. Quick, runs in the repo, good for every change to the prompt, gate or retries.
2. **The 500-case benchmark**: a larger suite covering generation, refusals, grounding, missing tools, risk warnings, profiles, the gate, config, the CLI and the shell hook. Its scripts, cases and raw results are in [`benchmarks/`](benchmarks/README.md).

## Current results

Final benchmark run: **`whatcmd2-20261104-2354`**, on commit `47e6b47`.

| Area | Config A (1.5b, grounding on) | Config B (1.5b, grounding off) | Config C (0.5b, grounding on) |
| --- | --- | --- | --- |
| **Overall** | **92.7%** (454 / 490) | 77.7% (272 / 350, model cases) | 68.0% (238 / 350, model cases) |
| Generation | **84.7%** (127 / 150) | 86.7% (130 / 150) | 66.0% (99 / 150) |
| Refusal | **98.8%** (79 / 80) | 100% (80 / 80) | 98.8% (79 / 80) |
| Grounding | 88% (44 / 50) | 0% (by design, no docs) | 8% (4 / 50) |
| Risk warnings | 95% (38 / 40) | 80% (16 / 20) | 55% (11 / 20) |
| Missing tools | 100% (30 / 30) | 100% (30 / 30) | 100% (30 / 30) |
| Profile (OS-specific answers) | 80% (16 / 20) | 80% (16 / 20) | 75% (15 / 20) |
| Gate (deterministic) | 100% (60 / 60) | not run | not run |
| Config (CLI) | 100% (30 / 30) | not run | not run |
| CLI behaviour | 100% (20 / 20) | not run | not run |
| Shell hook, zsh | 10 / 10 | not run | not run |

Config B and C are only run on model-based cases. Config B has grounding switched off, so its grounding cases cannot pass by design.

**Speed (config A):** model call p50 121 ms, p90 422 ms, p99 739 ms. Whole command `whatcmd --raw` p50 217 ms, p90 330 ms. First request after the model unloads about 0.8 s. Output stability: 50 of 50 random cases gave identical output across 3 runs.

**Eval (`npm run eval`, same commit and model):** 35 of 48 valid requests correct, 34 of 35 non-shell requests blocked, latency p50 105 ms, p90 218 ms. Recorded in `benchmarks/results/eval-2026-11-05.txt`.

**Hardware:** Apple M4 Pro, 14 cores (10 performance), 48 GB RAM, macOS 15.6.1, Node 22.16, Ollama 0.40.14, zsh 5.9, bash 3.2 (system).

### Known gaps in these numbers

- **Generation is 84.7% against an 85% goal.** One case short. Not fixed; a release decision.
- **Bash shortcut not verified.** The 10 bash hook scenarios were skipped because this Mac's system bash is 3.2.
- **One machine.** Linux and other Ollama versions are not covered.
- **Some test expectations are strict.** A few cases only accept one form of a correct answer. The benchmark's change log lists which expectations were changed, why, and which are still flagged. See [`benchmarks/CHANGES_TO_TESTS.md`](benchmarks/CHANGES_TO_TESTS.md).

## History of the benchmark

Each run is kept as a separate folder in `benchmarks/results/`. Every change between runs is in the change log.

| Run | Commit | Overall (A) | Generation | Refusal | What changed |
| --- | --- | --- | --- | --- | --- |
| 1 | `ac60e0b` | 85.3% | 74.0% | 93.8% | First full run. |
| 2 (rerun) | `f8c197e` | 91.2% | 85.3% | 92.5% | Upstream fixes: `nice` wrapper, `chmod 666`, grounding timeouts, macOS `sed` and tool hints. Six expectations corrected. |
| 3 (rerun2) | `ca01849` | 90.2% | 79.3% | 98.8% | Second-chance prompt no longer answers non-shell questions. Generation dropped. |
| 4 (rerun3) | `beeb680` | 92.7% | 84.7% | 98.8% | Prompt change to recover generation. One expectation corrected (`risk-model-005`). |
| 5 (whatcmd) | `47e6b47` | 92.2% | 84.7% | 98.8% | Project renamed to whatcmd. Harness and case inputs updated; two stale expectations still failing. |
| **6 (whatcmd2)** | **`47e6b47`** | **92.7%** | **84.7%** | **98.8%** | **Final.** Stale `cli-shell` expectations corrected. |

Run 6 has no product bugs in the deterministic categories (gate, config, CLI, risk function and hook).

## The eval in detail

**Files:** `eval/cases.json` (cases), `scripts/eval.mjs` (runner).

**Cases:** `valid` (48) are requests with a regular expression each command must match. `invalid` (35) are non-shell requests that must produce nothing.

**Output:**

```text
valid requests answered correctly: 35/48
non-shell requests blocked:        34/35
latency p50 105 ms, p90 218 ms, max 645 ms
```

**Options:**

| Flag | Effect |
| --- | --- |
| `--model=NAME` | Use another Ollama model for this run. |
| `--no-grounding` | Turn off reading local docs. |
| `VERBOSE=1` | Print every answer, not just failures. |

The eval uses your normal config (`whatcmd config`). To keep it away from your own settings, point it at a scratch folder:

```bash
WHATCMD_CONFIG_DIR=/tmp/whatcmd-eval WHATCMD_CACHE_DIR=/tmp/whatcmd-cache npm run eval
```

## The 500-case benchmark in detail

### Design

| Category | Cases | What it checks |
| --- | --- | --- |
| generation | 150 | Plain-English requests across 10 areas: files and search, text, processes, networking, archives, git, docker, system and disk, permissions and users, and miscellaneous. |
| refusal | 80 | Greetings, trivia, maths, creative writing, advice, translation, coding questions, gibberish, prompt injection, emoji and single words. Must produce nothing. |
| grounding | 50 | 20 invented flags on three fake tools (proves docs are read), 30 flags on real installed tools. |
| missing_tool | 30 | Requests that name a tool that is not installed. Pass if the tool is avoided, installed, or warned about. |
| risk | 40 | 20 model cases that should produce dangerous commands with a warning, and 20 deterministic `riskWarnings` checks (15 dangerous, 5 safe). |
| profile | 20 | Answers must fit this OS: BSD `sed -i ''`, the detected package manager, BSD date and stat flags, no Linux-only tools. |
| gate | 60 | `extractCommand`, `splitSegments`, `commandWords`, `check`. Deterministic. |
| config | 30 | `config set/get/unset`, invalid values, host normalisation, environment overrides. Runs the CLI. |
| cli | 20 | `--version`, `--help`, `--raw` exit codes, unreachable Ollama, missing model, `doctor --yes`, and more. |
| hook | 20 | Ten shell-hook scenarios for bash and zsh. Bash skipped on bash 3.2. |

Each case is one line of JSON in `cases/*.jsonl`. The expectation types are `command`, `rejected`, `grounded`, `missing_tool`, `risk`, `fn` (direct function call), `cli` and `hook`.

### Configurations

- **A:** `qwen2.5-coder:1.5b`, grounding on, all 500 cases. The headline result.
- **B:** same model, grounding off, model-based cases only. Shows what grounding adds.
- **C:** `qwen2.5-coder:0.5b`, grounding on, model-based cases only. Shows the smaller model's cost.

### Method

- Cases run one at a time, never in parallel, with a 60-second limit each.
- Temperature 0, the same profile for every case, and a warm-up call before timing.
- Every number in the report is computed by `harness/report.mjs` from the result files. No figure is typed by hand.
- Expectations were written before the first run. After results were seen, a small number were changed, and each change is logged with the old value, new value and reason.

### Reproducing

See [`benchmarks/README.md`](benchmarks/README.md) for the folder layout, the commands in order, and the files produced. The harness expects a local Ollama with the two models downloaded.

## Reading the numbers honestly

- **Pass rate is not accuracy in general.** It is the share of these 500 cases that passed. The cases are chosen to cover the product's behaviour, not a random sample of real use.
- **The missing-tool category is lenient.** A correct answer can be "use a different tool", "warn that this tool is missing", or "install it". All count as a pass, so 100% says little on its own.
- **Grounding numbers depend on the fake tools.** On fake tools the model cannot know the flags unless it reads the docs, so that is the real test. On real tools, many flags are guessable, so the difference is smaller.
- **Small differences are noise.** Between runs, a few generation cases flip. The per-case flip list is in each run's `report.md`.
