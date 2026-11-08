// Before/after for web lookup: runs the cloud-CLI cases with web off, then on, and the
// refusal cases with web on (web docs must not turn a non-shell request into a command).
// Usage: npm run eval:web -- [--model=NAME] [--limit=N] [--fresh]   (needs Ollama and tiny-browse)
//   --fresh  empty the web cache first, to measure cold lookups
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
// Own cache dir, so docs and web pages cached here never mix with your real cache.
const cache = path.join(os.tmpdir(), "whatcmd-web-eval-cache");
if (args.includes("--fresh")) fs.rmSync(path.join(cache, "web"), { recursive: true, force: true });
process.env.WHATCMD_CACHE_DIR = cache;

const { loadConfig } = await import("../dist/config.js");
const { detectProfile } = await import("../dist/env.js");
const { generate } = await import("../dist/generate.js");

const cfg = loadConfig();
if (opt("model")) cfg.model = opt("model");
cfg.profile ??= detectProfile();
const limit = Number(opt("limit") ?? Infinity);

const read = (f) =>
  fs.readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cloud = read("../benchmarks/cases/17-cloud-cli.jsonl").slice(0, limit);
const refusals = JSON.parse(fs.readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8")).invalid;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : 0;
};

async function runCloud(web) {
  const rows = [];
  for (const c of cloud) {
    const t = performance.now();
    const r = await generate(c.input, { ...cfg, web });
    const ms = performance.now() - t;
    const got = r.kind === "command" ? r.command : `(rejected: ${r.reason})`;
    const pass = r.kind === "command" && c.expect.all.every((re) => new RegExp(re).test(r.command));
    const usedWeb = r.debug.refs.some((x) => x.source === "web");
    rows.push({ id: c.id, input: c.input, pass, got, ms, usedWeb, why: r.debug.retries.filter((x) => x.startsWith("web")) });
  }
  return rows;
}

await generate("list files", cfg); // load the model
console.log(`model ${cfg.model}, ${cloud.length} cloud-CLI cases\n`);

const before = await runCloud(false);
const after = await runCloud(true);

let leaks = 0;
for (const ask of refusals) {
  const r = await generate(ask, { ...cfg, web: true });
  if (r.kind === "command") {
    leaks++;
    console.log(`LEAK (web on)  ${ask}  =>  ${r.command}`);
  }
}

for (let i = 0; i < before.length; i++) {
  const b = before[i], a = after[i];
  if (b.pass === a.pass && !process.env.VERBOSE) continue;
  const tag = b.pass && !a.pass ? "WORSE" : !b.pass && a.pass ? "FIXED" : a.pass ? "ok   " : "FAIL ";
  console.log(`${tag} ${a.input}\n      off: ${b.got}\n      on:  ${a.got}${a.usedWeb ? `  [web: ${a.why.join(",")}]` : ""}`);
}

const sum = (rows) => {
  const ms = rows.map((r) => r.ms);
  return `${rows.filter((r) => r.pass).length}/${rows.length} pass   p50 ${pct(ms, 50)} ms   p95 ${pct(ms, 95)} ms`;
};
console.log(`\nweb off: ${sum(before)}`);
console.log(`web on:  ${sum(after)}   used web docs: ${after.filter((r) => r.usedWeb).length}`);
console.log(`refusals with web on: ${refusals.length - leaks}/${refusals.length} still refused`);
console.log(`(web cache: ${path.join(cache, "web")}; run with --fresh for cold-lookup timings)`);
