// Validates cases/*.jsonl. Usage: node harness/validate-cases.mjs [--final]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), "cmdkit-bench");
const CASES = path.join(ROOT, "cases");
const FINAL = process.argv.includes("--final");

const EXPECTED = {
  generation: 150, refusal: 80, grounding: 50, missing_tool: 30, risk: 40,
  profile: 20, gate: 60, config: 30, cli: 20, hook: 20, cloud: 40,
};
const TYPE_FOR = {
  generation: ["command"], refusal: ["rejected"], grounding: ["grounded"],
  missing_tool: ["missing_tool"], risk: ["risk", "fn"], profile: ["command"],
  gate: ["fn"], config: ["cli"], cli: ["cli"], hook: ["hook"], cloud: ["command"],
};

const errors = [];
const ids = new Set();
const counts = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, 0]));
const inputs = new Map(); // category -> Set(input)
const split = { "grounding:fake": 0, "grounding:real": 0, "risk:model": 0, "risk:fn": 0 };

function regexOk(src, where) {
  try { new RegExp(src); } catch (e) { errors.push(`${where}: bad regex ${JSON.stringify(src)} (${e.message})`); }
}

const files = fs.readdirSync(CASES).filter((f) => f.endsWith(".jsonl")).sort();
let total = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(CASES, f), "utf8").split("\n").filter((l) => l.trim());
  if (lines.length > 50) errors.push(`${f}: has ${lines.length} cases (max 50 per file)`);
  lines.forEach((line, i) => {
    const where = `${f}:${i + 1}`;
    let c;
    try { c = JSON.parse(line); } catch (e) { errors.push(`${where}: invalid JSON`); return; }
    total++;
    if (!c.id || typeof c.id !== "string") errors.push(`${where}: missing id`);
    else if (ids.has(c.id)) errors.push(`${where}: duplicate id ${c.id}`);
    else ids.add(c.id);
    if (!(c.category in EXPECTED)) { errors.push(`${where}: bad category ${c.category}`); return; }
    counts[c.category]++;
    const t = c.expect?.type;
    if (!TYPE_FOR[c.category].includes(t)) errors.push(`${where}: expect.type ${t} not allowed for ${c.category}`);
    if (typeof c.input !== "string") errors.push(`${where}: input must be a string`);
    const set = inputs.get(c.category) ?? new Set();
    if (set.has(c.input)) errors.push(`${where}: duplicate input within ${c.category}: ${c.input}`);
    set.add(c.input);
    inputs.set(c.category, set);
    const e = c.expect ?? {};
    for (const k of ["all", "any", "none"]) (e[k] ?? []).forEach((r) => regexOk(r, `${where} ${k}`));
    if (t === "grounded") (e.all ?? []).forEach((r) => regexOk(r, `${where} all`));
    if (t === "risk") (e.all ?? []).forEach((r) => regexOk(r, `${where} all`));
    if (t === "cli") { for (const k of ["stdout", "stderr"]) if (e[k]) regexOk(e[k], `${where} ${k}`); }
    if (c.category === "grounding") {
      if (c.id.startsWith("grd-fake-")) split["grounding:fake"]++;
      else if (c.id.startsWith("grd-real-")) split["grounding:real"]++;
      else errors.push(`${where}: grounding id must start with grd-fake- or grd-real-`);
    }
    if (c.category === "risk") {
      if (t === "risk") split["risk:model"]++; else split["risk:fn"]++;
    }
  });
}

const rows = Object.keys(EXPECTED).map((k) => `| ${k} | ${counts[k]} | ${EXPECTED[k]} | ${counts[k] === EXPECTED[k] ? "ok" : "MISMATCH"} |`);
console.log(`files: ${files.join(", ")}`);
console.log("| category | count | target | status |\n|---|---|---|---|\n" + rows.join("\n"));
console.log(`total: ${total}`);
console.log("splits:", JSON.stringify(split));

if (FINAL) {
  if (total !== 500) errors.push(`total ${total} != 500`);
  for (const k of Object.keys(EXPECTED)) if (counts[k] !== EXPECTED[k]) errors.push(`${k}: ${counts[k]} != ${EXPECTED[k]}`);
  if (split["grounding:fake"] !== 20) errors.push(`grounding fake ${split["grounding:fake"]} != 20`);
  if (split["grounding:real"] !== 30) errors.push(`grounding real ${split["grounding:real"]} != 30`);
  if (split["risk:model"] !== 20 || split["risk:fn"] !== 20) errors.push(`risk split ${JSON.stringify(split)}`);
}
if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log(FINAL ? "\nFINAL VALIDATION PASSED: 500 valid cases." : "\nno problems so far");
