# CHANGES_TO_TESTS.md

No test expectations were changed after the first results were seen.
Log format: case id | old value | new value | reason.

## Changes made after results were seen

None. No case, regex or expected value was edited after the config A/B/C runs. The only edits to case files happened before any run:
- gate-ext-009, gate-split-012 and gate-check-004 had identical empty `input` strings, which the validator rejects. They were renamed to labelled inputs (`<empty string> (extract)` etc.). The `args` are unchanged.
- gate-split-007 was invalid JSON (`\;`), fixed to `\;`.
Both were fixed while validating, before the first results file existed.

## Flagged for your review (left unchanged, per rule 6)

These failed in the results. They may be over-strict or questionable expectations, so I did not loosen them. Decide whether to change them in a separate, logged pass.

| id | why it may be a test problem | result |
|---|---|---|
| grd-real-005 | `jq -r . input.json` pretty-prints objects; the regex `jq\s+\.` rejects the `-r` form | A fail |
| grd-real-015 | `openssl genpkey -algorithm RSA ... rsa_keygen_bits:2048` is a valid key command; regex only allows `genrsa\|req` | A fail |
| grd-real-027 | `ffmpeg -i movie.mp4 -c:a copy output.mp3` extracts audio; regex requires `-vn` or `-map` | A fail |
| ref-math-002 | "what is 15% of 240" is computable in the shell (`echo $((240*15/100))`, bc). The authoring rule said to avoid requests a shell could genuinely do. | A fail (model returned a bc command) |
| ref-math-003 | Same issue: a discounted price is computable with bc | A fail (model returned a bc command) |
| risk-model-006 | `chmod 666` also makes a file writable by everyone, but the expectation requires `777` and the warning | A fail. Also a product gap: riskWarnings does not flag `chmod 666`. |

## Re-run changes (approved by you after run 1, applied before the re-run)

Run 1 was on cmdkit commit ac60e0b. The re-run is on f8c197e ("Fix issues found by the 500-case benchmark"). These six edits were made after seeing run 1 results, on your instruction. The re-run results are the ones to compare, and both runs are kept in results/.

| case id | field | old value | new value | reason |
|---|---|---|---|---|
| grd-real-005 | expect.all | `jq\s+\.` | `jq\s+(-[a-zA-Z]+\s+)*\.` | `jq -r .` is a valid pretty-print answer; the old regex rejected the `-r` form |
| grd-real-015 | expect.all | `genrsa\|req` (and `2048`) | `genrsa\|req\|genpkey` (and `2048`) | `openssl genpkey -algorithm RSA ... rsa_keygen_bits:2048` is a valid key command |
| grd-real-027 | expect.all | `ffmpeg`, `movie\.mp4`, `-vn\|-map` | `ffmpeg`, `movie\.mp4`, `\.mp3` | Audio extraction to mp3 can be done with `-c:a copy` as well as `-vn`/`-map` |
| ref-math-002 | input | `what is 15% of 240` | `explain the intuition behind the fundamental theorem of calculus` | The original is computable in the shell (bc, `$((...))`), which the authoring rule said to avoid. Expectation (rejected) unchanged. |
| ref-math-003 | input | `a shirt costs 20 dollars with a 25% discount, what is the final price` | `prove that the square root of 2 is irrational` | Same reason as ref-math-002. Expectation (rejected) unchanged. |
| risk-model-006 | expect.all | `chmod\s+(-[a-zA-Z]+\s+)*777` | `chmod\s+(-[a-zA-Z]+\s+)*(666\|777)` | `chmod 666` also makes a file writable by everyone. The warning expectation is unchanged. |

Harness change (no scoring change): every script that writes results now honours `BENCH_RESULTS` (run.mjs, hooks.py, measure.mjs, stability.mjs, report.mjs). The sandbox docs caches were cleared before the re-run.

Note: `npm test` in the repo reports 1 failure at upstream commit f8c197e: `bash older than 4 is detected`. Its last assertion assumes `bash` on PATH is 5.x. This machine's `bash` is 3.2, so the assertion is machine-dependent. It is not a benchmark case, and it is left unchanged.

## Re-run 2 change (approved by you, applied before rerun2)

| case id | field | old value | new value | reason |
|---|---|---|---|---|
| gate-check-010 | input, expect.args | `echo a \| b` | `echo a` piped into `wc -c` (real pipe) | Run 1 expected `echo a \| b` to pass. `\|` escapes the pipe, so the command only prints text, and rejecting it is the correct behaviour. The probe is replaced with a real pipe. |

Note: the new input is `echo a | wc -c` (a real pipe, `ok: true`, `missing: []`, `risks: []`). The old input was a product-bug probe. Its result is kept in run 1 and rerun results, which were recorded as product bugs at the time.

## Re-run 3 change (approved by you, applied before rerun3)

| case id | field | old value | new value | reason |
|---|---|---|---|---|
| risk-model-005 | expect.all[1] | `\|\s*(sudo\s+)?(ba\|z)?sh` | `\|\s*(sudo\s+)?(ba\|z)?sh\|(ba\|z)?sh\s+-c\s+["']?\$\(\s*(curl\|wget)` | Run 1 and rerun required a pipe. `sh -c "$(curl ...)"` also runs a downloaded script, and cmdkit warns on it. The warning expectation is unchanged. |

Test-suite note: `npm test` at beeb680 reports 30 pass, 0 fail.

## whatcmd rename (product commit 47e6b47, applied before the whatcmd run)

Expectations were not changed. Only case inputs and harness plumbing moved to the new names.

| case id | field | old value | new value | reason |
|---|---|---|---|---|
| cli-host-001 | input label, env key | `unreachable host from CMDKIT_HOST`, `CMDKIT_HOST` | `unreachable host from WHATCMD_HOST`, `WHATCMD_HOST` | Product reads `WHATCMD_HOST`. Without the rename, the case would not test an unreachable host. |
| cli-models-002 | env key | `CMDKIT_HOST` | `WHATCMD_HOST` | Same reason. |
| cfg-env-001 | input label, env key | `CMDKIT_MODEL overrides file`, `CMDKIT_MODEL` | `WHATCMD_MODEL overrides file`, `WHATCMD_MODEL` | Product reads `WHATCMD_MODEL`. |

Known stale expectations (kept as written, not changed):
- cli-shell-001 expects stdout `cmdkit shell hook for bash`. The product now prints `whatcmd shell hook for bash`.
- cli-shell-002 expects stdout `cmdkit shell hook for zsh`. The product now prints `whatcmd shell hook for zsh`.
These two are reported as failures in the whatcmd run. They are a naming mismatch in the expectation, not a product bug.

Harness changes (no scoring change): `bin/cmdkit` is now `bin/whatcmd` (same target). Env vars are `WHATCMD_*`. The hook trigger is `/w`. Sandbox config and cache folders are under `whatcmd`. The rc marker is `# >>> whatcmd >>>`. The benchmark folder itself stays `~/cmdkit-bench`.

## Stale expectation fix (approved by you, applied before the whatcmd rerun)

| case id | field | old value | new value | reason |
|---|---|---|---|---|
| cli-shell-001 | expect.stdout | `cmdkit shell hook for bash` | `whatcmd shell hook for bash` | Product renamed the hook header in 47e6b47. The expectation was stale, not a product bug. |
| cli-shell-002 | expect.stdout | `cmdkit shell hook for zsh` | `whatcmd shell hook for zsh` | Same reason. |
