# Benchmarks

This folder holds the raw material behind the numbers in [EVALS.md](../EVALS.md):

- the **500 test cases** that define what "correct" means,
- the **harness** that runs them and writes the reports,
- the **results** of every run, so any figure can be checked,
- the **change log** of every expectation that was edited.

The final run is in `results/final-whatcmd2-47e6b47/`. Its report is [report.md](results/final-whatcmd2-47e6b47/report.md).

## Layout

```text
benchmarks/
├── README.md                          this file
├── CHANGES_TO_TESTS.md                every case edit, with old value, new value and reason
├── cases/                             500 cases, one JSON object per line
│   ├── 01-generation-a.jsonl … 04-generation-d.jsonl   generation (150)
│   ├── 05-refusal-a.jsonl, 06-refusal-b.jsonl          refusal (80)
│   ├── 07-grounding.jsonl                              grounding (50)
│   ├── 08-missing-tool.jsonl                           missing tools (30)
│   ├── 09-risk-model.jsonl, 10-risk-fn.jsonl           risk (20 + 20)
│   ├── 11-profile.jsonl                                profile (20)
│   ├── 12-gate-a.jsonl, 13-gate-b.jsonl                gate (60)
│   ├── 14-config.jsonl                                 config (30)
│   ├── 15-cli.jsonl                                    CLI (20)
│   └── 16-hook.jsonl                                   shell hook (20)
├── harness/
│   ├── validate-cases.mjs     checks the cases; --final requires exactly 500 with the right split
│   ├── run.mjs                runs one config; writes results/<config>/results.jsonl
│   ├── hooks.py               drives interactive zsh (and bash, if available) through a pseudo-terminal
│   ├── measure.mjs            CLI end-to-end latency and cold start
│   ├── stability.mjs          50 random cases, 3 runs each, identical output?
│   ├── report.mjs             builds summary.json and report.md from the result files
│   └── capture-env.mjs        records the environment and the tool inventory
├── results/
│   ├── final-whatcmd2-47e6b47/   final run: configs A, B, C; report; summary; environment; tools
│   ├── whatcmd-47e6b47/          same commit, before two stale expectations were corrected
│   ├── rerun3-cmdkit-beeb680/    earlier runs, one folder each, named by commit
│   ├── rerun2-cmdkit-ca01849/
│   ├── rerun-cmdkit-f8c197e/
│   ├── run1-cmdkit-ac60e0b/
│   └── eval-2026-11-05.txt       output of `npm run eval` on the final commit
```

Each run folder that holds per-config results has a `results.jsonl` line for every case: `id`, `category`, `input`, `pass`, `got`, `warnings`, `refs`, `outcome`, `ms`, `llm_calls` and `error`.

## Configurations

| Config | Model | Grounding | Cases |
| --- | --- | --- | --- |
| A | `qwen2.5-coder:1.5b` | on | all 500 (480 run by the harness, 20 hook rows: 10 zsh run, 10 bash skipped) |
| B | `qwen2.5-coder:1.5b` | off | model-based cases only (350) |
| C | `qwen2.5-coder:0.5b` | on | model-based cases only (350) |

Model-based categories are generation, refusal, grounding, missing_tool, profile and the model risk cases.

## How to reproduce

### 1. Requirements

- macOS or Linux, Node.js 18.17 or newer, npm.
- [Ollama](https://ollama.com) running on `http://127.0.0.1:11434`.
- The two models: `ollama pull qwen2.5-coder:1.5b` and `ollama pull qwen2.5-coder:0.5b`.
- Optional, for the bash shell-hook scenarios: bash 4 or newer (`brew install bash`).

### 2. Layout the harness expects

The harness assumes the following folder, under your home directory:

```text
~/cmdkit-bench/
├── repo/        a checkout of this repository at the commit you want to measure (npm ci; npm run build)
├── cases/       copy of benchmarks/cases
├── harness/     copy of benchmarks/harness
├── bin/         holds a `whatcmd` symlink to repo/dist/cli.js, plus the fake tools zorbctl, qlipper, mendaro
├── sandbox/     created by the harness: config, cache and HOME folders per run
└── results/     created by the harness: one folder per run
```

The fake tools print a usage line and invented options, so grounding can be checked: a model cannot know those flags unless it reads the docs. Each prints `ok` and exits 0 for any other arguments.

The harness never touches your real `~/.zshrc`, `~/.bashrc` or `~/.config/whatcmd`. Every run sets `WHATCMD_CONFIG_DIR` and `WHATCMD_CACHE_DIR` inside `sandbox/`, and the shell-hook scenarios use a sandbox `HOME`.

### 3. Commands, in order

```bash
cd ~/cmdkit-bench
node harness/validate-cases.mjs --final            # must print 500 cases, with the right split

export BENCH_RESULTS=$HOME/cmdkit-bench/results/my-run
mkdir -p "$BENCH_RESULTS"
rm -rf sandbox/A/cache sandbox/B/cache sandbox/C/cache   # start from empty docs caches

node harness/run.mjs --config=A --model=qwen2.5-coder:1.5b --grounding=on
python3 harness/hooks.py                            # appends the 20 hook rows to results/A
node harness/run.mjs --config=B --model=qwen2.5-coder:1.5b --grounding=off
node harness/run.mjs --config=C --model=qwen2.5-coder:0.5b --grounding=on

node harness/measure.mjs --config=A                 # CLI latency and cold start
node harness/stability.mjs --config=A --model=qwen2.5-coder:1.5b
node harness/report.mjs                             # writes $BENCH_RESULTS/report.md and summary.json
```

`BENCH_RESULTS` tells every script where to write. Without it, results go into `~/cmdkit-bench/results/`.

### 4. Time and cost

A full run takes roughly 10 minutes on the reference machine: config A is about 3 minutes, the hook scenarios about 1 minute, B and C about 1 minute each, and the measurements about 2 minutes.

## What the scoring means

- **Overall** = passed / scored. Skipped rows (bash hook scenarios on bash 3.2) are left out.
- **Generation, refusal, grounding, missing_tool, risk, profile** are the model-based categories. Their pass rules are in [EVALS.md](../EVALS.md#the-500-case-benchmark-in-detail).
- **Gate, risk function, config, CLI and hook** are deterministic or CLI checks. Any failure there is a product bug, unless the expectation is shown to be wrong in `CHANGES_TO_TESTS.md`.
- **Latency** is for model-based cases only, measured around the call to the model, including grounding.
- **Stability** runs 50 random model-based cases three times each. A case is stable when all three outputs are the same.

## Rules followed for the cases

1. Expectations were written before the first run.
2. After results were seen, only harness bugs and clearly wrong cases were changed. Every change is in `CHANGES_TO_TESTS.md`, with the old value, the new value and the reason.
3. No expectation was loosened to make a model answer pass. Where an expectation looked strict, it was flagged, and changed only when the change was approved and logged.
4. Where the product name changed, only inputs and harness plumbing moved to the new name. Expectations stayed as they were, apart from the two stale `cli-shell` strings, which were corrected and logged.

## Limitations

- **One machine:** Apple M4 Pro, macOS 15.6.1, Ollama 0.40.14.
- **Bash scenarios** are skipped on macOS's bash 3.2. They are run only when bash 4 or newer is available.
- **Timing depends on the machine and on the model being loaded.** The cold-start figures measure the first request after `ollama stop`.
- **Local paths and names** in these files were replaced with `$HOME` and `user` before publishing. The harness itself uses your home directory when you run it.
