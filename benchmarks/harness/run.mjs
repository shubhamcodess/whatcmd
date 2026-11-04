// Runs cases for one config. Usage:
//   node harness/run.mjs --config=A --model=qwen2.5-coder:1.5b --grounding=on [--categories=a,b] [--limit=N]
// Hook cases are run by harness/hooks.py and appended to the same results.jsonl.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const ROOT = path.join(os.homedir(), "cmdkit-bench");
const REPO = path.join(ROOT, "repo");
const BIN = path.join(ROOT, "bin");
const CLI = path.join(REPO, "dist", "cli.js");
const SANDBOX = path.join(ROOT, "sandbox");
const CASE_TIMEOUT = 60000;
const MODEL_CATS = new Set(["generation", "refusal", "grounding", "missing_tool", "profile"]);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return [m[1], m[2] ?? true];
}));
const config = args.config;
const model = args.model;
const grounding = args.grounding === "on";
if (!config || !model || !args.grounding) {
  console.error("usage: run.mjs --config=A --model=M --grounding=on|off [--categories=a,b] [--limit=N]");
  process.exit(2);
}
const onlyCats = args.categories ? new Set(args.categories.split(",")) : null;
const limit = args.limit ? Number(args.limit) : Infinity;

// ---- isolation: sandbox PATH, sandbox config/cache, no inherited whatcmd env ----
process.env.PATH = `${BIN}:${process.env.PATH}`;
for (const k of ["WHATCMD_HOST", "WHATCMD_MODEL", "OLLAMA_HOST", "WHATCMD_CONFIG_DIR", "WHATCMD_CACHE_DIR"]) delete process.env[k];
const CFG_DIR = path.join(SANDBOX, config, "config");
const CACHE_DIR = path.join(SANDBOX, config, "cache");
fs.mkdirSync(CFG_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
process.env.WHATCMD_CONFIG_DIR = CFG_DIR;
process.env.WHATCMD_CACHE_DIR = CACHE_DIR;

const { loadConfig, writeStored } = await import(path.join(REPO, "dist", "config.js"));
const { detectProfile } = await import(path.join(REPO, "dist", "env.js"));
const { generate } = await import(path.join(REPO, "dist", "generate.js"));
const gate = await import(path.join(REPO, "dist", "gate.js"));
const FN = { extractCommand: gate.extractCommand, splitSegments: gate.splitSegments, commandWords: gate.commandWords, check: gate.check, riskWarnings: gate.riskWarnings };

const profile = detectProfile();
writeStored({ model, grounding, profile, timeoutMs: CASE_TIMEOUT, host: "http://127.0.0.1:11434", prefix: "/w", temperature: 0, keepAlive: "2h", notes: "" });
const cfg = loadConfig();

const RESULTS_ROOT = process.env.BENCH_RESULTS || path.join(ROOT, "results");
const resultsDir = path.join(RESULTS_ROOT, config);
fs.mkdirSync(resultsDir, { recursive: true });
const resultsFile = path.join(resultsDir, "results.jsonl");
fs.writeFileSync(resultsFile, "");

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const matchesAll = (list, s) => list.every((r) => new RegExp(r).test(s));
const matchesAny = (list, s) => list.some((r) => new RegExp(r).test(s));

function loadCases() {
  const dir = path.join(ROOT, "cases");
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort())
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) out.push(JSON.parse(line));
  return out;
}

// Which cases this config runs. B and C: model-based only (generation, refusal, grounding, missing_tool, risk-model, profile).
function selected(c) {
  if (c.category === "hook") return false; // run by hooks.py
  if (config === "B" || config === "C") {
    if (MODEL_CATS.has(c.category)) return true;
    return c.category === "risk" && c.expect.type === "risk";
  }
  return true;
}

async function runModelCase(c) {
  const e = c.expect;
  const t0 = performance.now();
  const res = await withTimeout(generate(c.input, cfg), CASE_TIMEOUT);
  const ms = Math.round(performance.now() - t0);
  const llm_calls = res.debug.outputs.length;
  const refs = res.debug.refs.map((r) => r.name);
  const warnings = res.kind === "command" ? res.warnings : [];
  const got = res.kind === "command" ? res.command : `rejected:${res.reason}`;
  let pass = false;
  let outcome = null;
  switch (e.type) {
    case "command":
      pass = res.kind === "command" && matchesAll(e.all, res.command) && (!e.any || matchesAny(e.any, res.command)) && !(e.none ?? []).some((r) => new RegExp(r).test(res.command));
      break;
    case "rejected":
      pass = res.kind === "rejected";
      break;
    case "grounded":
      pass = res.kind === "command" && refs.includes(e.tool) && matchesAll(e.all, res.command);
      break;
    case "risk":
      pass = res.kind === "command" && matchesAll(e.all, res.command) && warnings.includes(e.warning);
      break;
    case "missing_tool":
      if (res.kind === "rejected") outcome = "rejected";
      else if (!commandWordsOf(res.command).includes(e.tool)) outcome = "alternative";
      else if (new RegExp(`\\bbrew\\s+install\\s+${e.tool}\\b`).test(res.command)) outcome = "installs";
      else if (warnings.includes(`${e.tool} is not installed on this system`)) outcome = "warned";
      else outcome = "uses_tool_no_warning";
      pass = outcome !== "uses_tool_no_warning";
      break;
    default:
      throw new Error(`unexpected model expect type ${e.type}`);
  }
  return { pass, got, warnings, refs, outcome, ms, llm_calls, error: null };
}
const commandWordsOf = (cmd) => gate.commandWords(cmd);

function runFnCase(c) {
  const e = c.expect;
  const t0 = performance.now();
  const fn = FN[e.fn];
  if (!fn) throw new Error(`unknown fn ${e.fn}`);
  const out = fn(...e.args);
  const ms = Math.round(performance.now() - t0);
  const compare = e.fn === "check" && e.equals && !Array.isArray(e.equals) ? Object.fromEntries(Object.keys(e.equals).map((k) => [k, out[k]])) : out;
  let pass = true;
  let error = null;
  try { assert.deepStrictEqual(compare, e.equals); } catch (err) { pass = false; error = "mismatch"; }
  return { pass, got: JSON.stringify(out), warnings: [], refs: [], outcome: null, ms, llm_calls: null, error };
}

function runCliCase(c) {
  const e = c.expect;
  const base = path.join(SANDBOX, "cli", c.id);
  fs.rmSync(base, { recursive: true, force: true });
  const cfgd = path.join(base, "config");
  const cached = path.join(base, "cache");
  const home = path.join(base, "home");
  for (const d of [cfgd, cached, home]) fs.mkdirSync(d, { recursive: true });
  const env = {
    PATH: `${BIN}:${process.env.PATH}`,
    HOME: home,
    WHATCMD_CONFIG_DIR: cfgd,
    WHATCMD_CACHE_DIR: cached,
    NO_COLOR: "1",
    LANG: "C",
    TERM: "dumb",
    ...(e.env ?? {}),
  };
  env.HOME = home; // "SANDBOX" placeholder and any override always resolve to the case's sandbox HOME
  for (const s of e.setup ?? []) spawnSync(process.execPath, [CLI, ...s], { env, cwd: home, timeout: CASE_TIMEOUT, encoding: "utf8" });
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...e.argv], { env, cwd: home, timeout: CASE_TIMEOUT, encoding: "utf8" });
  const ms = Math.round(performance.now() - t0);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const problems = [];
  if (r.error && r.error.code === "ETIMEDOUT") problems.push("timeout");
  if (r.status !== e.exit) problems.push(`exit ${r.status} != ${e.exit}`);
  if (e.stdout && !new RegExp(e.stdout).test(stdout)) problems.push("stdout no match");
  if (e.stderr && !new RegExp(e.stderr).test(stderr)) problems.push("stderr no match");
  const got = `exit=${r.status} stdout=${JSON.stringify(stdout.slice(0, 160))} stderr=${JSON.stringify(stderr.slice(0, 160))}`;
  return { pass: problems.length === 0, got, warnings: [], refs: [], outcome: null, ms, llm_calls: null, error: problems.length ? problems.join("; ") : null };
}

async function main() {
  // Warm-up: load the model once, timed, before any measured case.
  const w0 = performance.now();
  await withTimeout(generate("list files", cfg), CASE_TIMEOUT);
  const warmup_ms = Math.round(performance.now() - w0);
  fs.writeFileSync(path.join(resultsDir, "meta.json"), JSON.stringify({ config, model, grounding, warmup_ms, started_at: new Date().toISOString() }, null, 2) + "\n");
  console.log(`config ${config}: model=${model} grounding=${grounding} warmup_ms=${warmup_ms}`);

  let cases = loadCases().filter(selected).filter((c) => !onlyCats || onlyCats.has(c.category));
  if (args.limit) cases = cases.slice(0, limit);
  console.log(`running ${cases.length} cases one at a time`);
  let passed = 0;
  let i = 0;
  for (const c of cases) {
    i++;
    let row;
    try {
      const isFn = c.expect.type === "fn";
      const isCli = c.expect.type === "cli";
      row = isFn ? runFnCase(c) : isCli ? runCliCase(c) : await runModelCase(c);
    } catch (err) {
      row = { pass: false, got: null, warnings: [], refs: [], outcome: null, ms: null, llm_calls: null, error: err.message === "timeout" ? "timeout" : `exception: ${err.message}` };
    }
    if (row.pass) passed++;
    const line = { id: c.id, category: c.category, input: c.input, pass: row.pass, got: row.got, warnings: row.warnings, refs: row.refs, outcome: row.outcome, ms: row.ms, llm_calls: row.llm_calls, error: row.error };
    fs.appendFileSync(resultsFile, JSON.stringify(line) + "\n");
    if (!row.pass || i % 25 === 0) console.log(`[${i}/${cases.length}] ${row.pass ? "PASS" : "FAIL"} ${c.id} ${row.ms ?? "-"}ms${row.error ? " " + row.error : ""}`);
  }
  console.log(`config ${config} done: ${passed}/${cases.length} passed -> ${resultsFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
