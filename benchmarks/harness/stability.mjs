// Stability: 50 random model-based cases, each generated 3 times with config A.
// Usage: node harness/stability.mjs --config=A --model=qwen2.5-coder:1.5b
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), "cmdkit-bench");
const REPO = path.join(ROOT, "repo");
const BIN = path.join(ROOT, "bin");
const config = (process.argv.find((a) => a.startsWith("--config=")) ?? "--config=A").split("=")[1];
const model = (process.argv.find((a) => a.startsWith("--model=")) ?? "--model=qwen2.5-coder:1.5b").split("=")[1];

process.env.PATH = `${BIN}:${process.env.PATH}`;
for (const k of ["WHATCMD_HOST", "WHATCMD_MODEL", "OLLAMA_HOST"]) delete process.env[k];
process.env.WHATCMD_CONFIG_DIR = path.join(ROOT, "sandbox", config, "config");
process.env.WHATCMD_CACHE_DIR = path.join(ROOT, "sandbox", config, "cache");

const { loadConfig, writeStored } = await import(path.join(REPO, "dist", "config.js"));
const { detectProfile } = await import(path.join(REPO, "dist", "env.js"));
const { generate } = await import(path.join(REPO, "dist", "generate.js"));

writeStored({ model, grounding: true, profile: detectProfile(), timeoutMs: 60000, host: "http://127.0.0.1:11434", prefix: "/w", temperature: 0, keepAlive: "2h", notes: "" });
const cfg = loadConfig();

// seeded PRNG so the sample is reproducible
let seed = 42;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MODEL_CATS = new Set(["generation", "refusal", "grounding", "missing_tool", "profile"]);
const pool = fs.readdirSync(path.join(ROOT, "cases")).filter((f) => f.endsWith(".jsonl")).sort()
  .flatMap((f) => fs.readFileSync(path.join(ROOT, "cases", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((c) => MODEL_CATS.has(c.category) || (c.category === "risk" && c.expect.type === "risk"));
const sample = [];
const idx = new Set();
while (sample.length < 50) {
  const i = Math.floor(rand() * pool.length);
  if (!idx.has(i)) { idx.add(i); sample.push(pool[i]); }
}

const rows = [];
for (const c of sample) {
  const outs = [];
  for (let k = 0; k < 3; k++) {
    const res = await generate(c.input, cfg);
    outs.push(res.kind === "command" ? res.command : `rejected:${res.reason}`);
  }
  rows.push({ id: c.id, category: c.category, input: c.input, outputs: outs, same: outs.every((o) => o === outs[0]) });
  process.stdout.write(rows.length % 10 === 0 ? `${rows.length} ` : "");
}
const same = rows.filter((r) => r.same).length;
const summary = { config, model, sample_size: rows.length, runs_per_case: 3, identical_all_three: same, pct_identical: Math.round((1000 * same) / rows.length) / 10, seed: 42 };
const outRoot = path.join(process.env.BENCH_RESULTS || path.join(ROOT, "results"), config);
fs.mkdirSync(outRoot, { recursive: true });
fs.writeFileSync(path.join(outRoot, "stability.json"), JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log("\nstability:", JSON.stringify(summary));
