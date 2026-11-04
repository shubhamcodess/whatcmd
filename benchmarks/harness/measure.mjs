// CLI end-to-end latency (30 runs of `whatcmd --raw -- <request>`) and cold start.
// Usage: node harness/measure.mjs --config=A
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execSync } from "node:child_process";

const ROOT = path.join(os.homedir(), "cmdkit-bench");
const CLI = path.join(ROOT, "repo", "dist", "cli.js");
const config = (process.argv.find((a) => a.startsWith("--config=")) ?? "--config=A").split("=")[1];
const MODEL = "qwen2.5-coder:1.5b";
const cfgDir = path.join(ROOT, "sandbox", config, "config");
const cacheDir = path.join(ROOT, "sandbox", config, "cache");
const outDir = path.join(process.env.BENCH_RESULTS || path.join(ROOT, "results"), config);
fs.mkdirSync(outDir, { recursive: true });

const env = {
  PATH: `${path.join(ROOT, "bin")}:${process.env.PATH}`,
  HOME: path.join(ROOT, "sandbox", config, "home"),
  WHATCMD_CONFIG_DIR: cfgDir,
  WHATCMD_CACHE_DIR: cacheDir,
  NO_COLOR: "1",
  LANG: "C",
  TERM: "dumb",
};

// 30 requests taken from the generation cases (every 5th case, so the sample spans all areas)
const gen = fs.readFileSync(path.join(ROOT, "cases", "01-generation-a.jsonl"), "utf8")
  .concat(fs.readFileSync(path.join(ROOT, "cases", "02-generation-b.jsonl"), "utf8"),
    fs.readFileSync(path.join(ROOT, "cases", "03-generation-c.jsonl"), "utf8"),
    fs.readFileSync(path.join(ROOT, "cases", "04-generation-d.jsonl"), "utf8"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const requests = gen.filter((_, i) => i % 5 === 0).slice(0, 30).map((c) => c.input);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

// warm the model once so the 30 runs measure a warm model (cold start is measured separately)
spawnSync(process.execPath, [CLI, "--raw", "--", "list files"], { env, encoding: "utf8", timeout: 120000 });

const e2e = [];
for (const req of requests) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, "--raw", "--", req], { env, encoding: "utf8", timeout: 120000 });
  const ms = Math.round(performance.now() - t0);
  e2e.push({ request: req, ms, exit: r.status, command: (r.stdout ?? "").trim() });
}
const times = e2e.map((x) => x.ms).sort((a, b) => a - b);
const e2eSummary = { n: e2e.length, p50_ms: pct(times, 50), p90_ms: pct(times, 90), max_ms: times[times.length - 1] };
fs.writeFileSync(path.join(outDir, "cli_e2e.json"), JSON.stringify({ summary: e2eSummary, runs: e2e }, null, 2) + "\n");
console.log("cli e2e:", JSON.stringify(e2eSummary));

// Cold start: unload the model, then time the first request (including Node startup).
const coldRuns = [];
let coldNote = null;
try {
  execSync("ollama --version", { stdio: "ignore" });
  for (let i = 0; i < 3; i++) {
    execSync(`ollama stop ${MODEL}`, { stdio: "ignore", timeout: 60000 });
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [CLI, "--raw", "--", "list files in this folder"], { env, encoding: "utf8", timeout: 120000 });
    coldRuns.push({ ms: Math.round(performance.now() - t0), exit: r.status, command: (r.stdout ?? "").trim() });
  }
} catch (e) {
  coldNote = `not measured: ${e.message.split("\n")[0]}`;
}
const cold = coldNote ? { measured: false, note: coldNote } : { measured: true, runs: coldRuns, note: "ollama stop before each run, then CLI wall time incl. Node startup" };
fs.writeFileSync(path.join(outDir, "cold_start.json"), JSON.stringify(cold, null, 2) + "\n");
console.log("cold start:", coldNote ?? coldRuns.map((x) => x.ms + "ms").join(", "));
