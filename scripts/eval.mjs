// End-to-end eval against a running Ollama: accuracy, refusals, latency.
// Usage: npm run eval -- [--model=NAME] [--no-grounding]
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { detectProfile } from "../dist/env.js";
import { generate } from "../dist/generate.js";

const args = process.argv.slice(2);
const cfg = loadConfig();
const m = args.find((a) => a.startsWith("--model="));
if (m) cfg.model = m.slice(8);
if (args.includes("--no-grounding")) cfg.grounding = false;
cfg.profile ??= detectProfile();

const cases = JSON.parse(fs.readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"));
const times = [];
let validOk = 0, invalidOk = 0, warnings = 0;

await generate("list files", cfg); // load the model

for (const c of cases.valid) {
  const t = performance.now();
  const r = await generate(c.ask, cfg);
  times.push(performance.now() - t);
  const pass = r.kind === "command" && c.expect.every((re) => new RegExp(re).test(r.command));
  validOk += pass;
  if (r.kind === "command" && r.warnings.length) warnings++;
  if (!pass) console.log(`FAIL  ${c.ask}  =>  ${r.kind === "command" ? r.command : `(rejected: ${r.reason})`}`);
  else if (process.env.VERBOSE) console.log(`ok    ${c.ask}  =>  ${r.command}  ${r.debug.refs.map((x) => `[${x.name}]`).join("")}`);
}
for (const ask of cases.invalid) {
  const t = performance.now();
  const r = await generate(ask, cfg);
  times.push(performance.now() - t);
  if (r.kind === "rejected") invalidOk++;
  else console.log(`LEAK  ${ask}  =>  ${r.command}`);
}

times.sort((a, b) => a - b);
const p = (q) => Math.round(times[Math.floor((times.length - 1) * q)]);
console.log(
  `\nmodel ${cfg.model} | grounding ${cfg.grounding ? "on" : "off"}\n` +
    `valid requests answered correctly: ${validOk}/${cases.valid.length}\n` +
    `non-shell requests blocked:        ${invalidOk}/${cases.invalid.length}\n` +
    `latency p50 ${p(0.5)} ms, p90 ${p(0.9)} ms, max ${p(1)} ms`,
);
