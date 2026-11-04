// Builds results/summary.json and results/report.md from the results files. Every number comes from here.
// Usage: node harness/report.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), "cmdkit-bench");
const RES = process.env.BENCH_RESULTS || path.join(ROOT, "results");
const CONFIGS = ["A", "B", "C"];
const CONFIG_LABEL = {
  A: "A: qwen2.5-coder:1.5b, grounding on, all 500",
  B: "B: qwen2.5-coder:1.5b, grounding off, model cases",
  C: "C: qwen2.5-coder:0.5b, grounding on, model cases",
};
const CATS = ["generation", "refusal", "grounding", "missing_tool", "risk", "profile", "gate", "config", "cli", "hook"];
const MODEL_CATS = new Set(["generation", "refusal", "grounding", "missing_tool", "profile"]);
const isModelCase = (r, c) => MODEL_CATS.has(r.category) || (r.category === "risk" && c?.expect?.type === "risk");

const cases = new Map();
for (const f of fs.readdirSync(path.join(ROOT, "cases")).filter((x) => x.endsWith(".jsonl")))
  for (const l of fs.readFileSync(path.join(ROOT, "cases", f), "utf8").split("\n").filter(Boolean)) {
    const c = JSON.parse(l);
    cases.set(c.id, c);
  }

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const env = readJson(path.join(RES, "environment.json"));
const tools = readJson(path.join(RES, "tools.json"));

function loadRows(cfg) {
  const p = path.join(RES, cfg, "results.jsonl");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const rowsBy = Object.fromEntries(CONFIGS.map((c) => [c, loadRows(c)]));
const meta = Object.fromEntries(CONFIGS.map((c) => [c, readJson(path.join(RES, c, "meta.json"))]));

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const rate = (passed, total) => (total ? Math.round((1000 * passed) / total) / 10 : null);
const scored = (rows) => rows.filter((r) => r.pass !== null && r.pass !== undefined);

function describeExpect(c) {
  if (!c) return "?";
  const e = c.expect;
  switch (e.type) {
    case "command": return `command: all=${JSON.stringify(e.all)}${e.any ? ` any=${JSON.stringify(e.any)}` : ""}${e.none ? ` none=${JSON.stringify(e.none)}` : ""}`;
    case "rejected": return "rejected (not a shell task)";
    case "grounded": return `grounded by ${e.tool}, all=${JSON.stringify(e.all)}`;
    case "risk": return `all=${JSON.stringify(e.all)} + warning "${e.warning}"`;
    case "missing_tool": return `missing_tool ${e.tool}`;
    case "fn": return `${e.fn}(${JSON.stringify(e.args)}) equals ${JSON.stringify(e.equals)}`;
    case "cli": return `exit ${e.exit}${e.stdout ? ` stdout~${e.stdout}` : ""}${e.stderr ? ` stderr~${e.stderr}` : ""}`;
    case "hook": return `hook ${e.shell}/${e.scenario}`;
    default: return e.type;
  }
}

const summary = { environment: env, configs: {}, cold_start: readJson(path.join(RES, "A", "cold_start.json")), cli_e2e: readJson(path.join(RES, "A", "cli_e2e.json"))?.summary ?? null, stability: readJson(path.join(RES, "A", "stability.json"))?.summary ?? null };

for (const cfg of CONFIGS) {
  const rows = rowsBy[cfg];
  if (!rows) continue;
  const sc = scored(rows);
  const passed = sc.filter((r) => r.pass).length;
  const perCat = {};
  for (const cat of CATS) {
    const cr = scored(rows.filter((r) => r.category === cat));
    const skipped = rows.filter((r) => r.category === cat && (r.pass === null || r.pass === undefined)).length;
    perCat[cat] = { total: cr.length, passed: cr.filter((r) => r.pass).length, pass_pct: rate(cr.filter((r) => r.pass).length, cr.length), skipped };
  }
  // latency over model-based cases
  const modelRows = sc.filter((r) => isModelCase(r, cases.get(r.id)) && typeof r.ms === "number");
  const lat = (rs) => {
    const ms = rs.map((r) => r.ms);
    return { n: ms.length, p50: pct(ms, 50), p90: pct(ms, 90), p99: pct(ms, 99), max: ms.length ? Math.max(...ms) : null };
  };
  const latPerCat = {};
  for (const cat of CATS) {
    const rs = modelRows.filter((r) => r.category === cat);
    if (rs.length) latPerCat[cat] = lat(rs);
  }
  const calls = modelRows.map((r) => r.llm_calls).filter((x) => typeof x === "number");
  const retries = calls.filter((x) => x >= 2).length;
  // grounding effect split by fake vs real tools
  const gFake = scored(rows.filter((r) => r.id.startsWith("grd-fake-")));
  const gReal = scored(rows.filter((r) => r.id.startsWith("grd-real-")));
  // missing_tool outcome breakdown
  const mtRows = rows.filter((r) => r.category === "missing_tool");
  const outcomes = {};
  for (const r of mtRows) outcomes[r.outcome ?? "none"] = (outcomes[r.outcome ?? "none"] ?? 0) + 1;
  // failures
  const failures = sc.filter((r) => !r.pass && !(cfg === "B" && r.category === "grounding")).map((r) => {
    const c = cases.get(r.id);
    return { id: r.id, category: r.category, input: r.input, expected: describeExpect(c), got: r.got, error: r.error ?? null, refs: r.refs ?? [] };
  });
  const isProductBug = (f) => ["gate", "config", "cli", "hook"].includes(f.category) || (f.category === "risk" && cases.get(f.id)?.expect.type === "fn") || (f.error ?? "").startsWith("exception") || (cfg !== "B" && f.category === "grounding" && !f.refs.includes(cases.get(f.id)?.expect.tool));
  summary.configs[cfg] = {
    label: CONFIG_LABEL[cfg],
    warmup_ms: meta[cfg]?.warmup_ms ?? null,
    total_rows: rows.length,
    scored: sc.length,
    passed,
    overall_pass_pct: rate(passed, sc.length),
    pass_pct_excluding_grounding: rate(sc.filter((r) => r.category !== "grounding" && r.pass).length, sc.filter((r) => r.category !== "grounding").length),
    grounding_failed_by_design: cfg === "B" ? sc.filter((r) => r.category === "grounding" && !r.pass).length : 0,
    per_category: perCat,
    latency_model_cases: { overall: lat(modelRows), per_category: latPerCat },
    avg_llm_calls_model_cases: calls.length ? Math.round((100 * calls.reduce((a, b) => a + b, 0)) / calls.length) / 100 : null,
    retry_rate_pct: calls.length ? rate(retries, calls.length) : null,
    grounding_effect: { fake_tools: { total: gFake.length, passed: gFake.filter((r) => r.pass).length, pass_pct: rate(gFake.filter((r) => r.pass).length, gFake.length) }, real_tools: { total: gReal.length, passed: gReal.filter((r) => r.pass).length, pass_pct: rate(gReal.filter((r) => r.pass).length, gReal.length) } },
    missing_tool_outcomes: outcomes,
    product_bug_failures: failures.filter(isProductBug),
    model_miss_failures: failures.filter((f) => !isProductBug(f)),
  };
}
fs.writeFileSync(path.join(RES, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

// ---- report.md ----
const f = (x, suffix = "") => (x === null || x === undefined ? "n/a" : `${x}${suffix}`);
const L = [];
L.push("# whatcmd benchmark report", "");
L.push(`Generated by harness/report.mjs from results/*. Every number below was computed from the results files.`, "");
L.push("## Environment", "");
if (env) {
  L.push(`- OS: ${env.os}`, `- CPU: ${env.cpu} (${env.cores} cores, ${env.performance_cores} performance cores), RAM: ${env.ram_gb} GB`, `- GPU: ${env.gpu}`, `- Node: ${env.node}`, `- Ollama: ${env.ollama} (server ${env.ollama_server})`, `- bash: ${env.bash} (bash hook scenarios skipped)`, `- zsh: ${env.zsh}`, `- Repo: cmdkit-mvp @ ${env.repo_commit}`, `- npm test: ${String(env.npm_test_summary).replace(/\n/g, ", ")}`, `- Captured: ${env.captured_at}`, "");
}
L.push("## Overall pass rate", "", "| config | scored | passed | pass % | pass % excluding grounding |", "|---|---|---|---|---|");
for (const cfg of CONFIGS) { const s = summary.configs[cfg]; if (s) L.push(`| ${CONFIG_LABEL[cfg]} | ${s.scored} | ${s.passed} | ${f(s.overall_pass_pct, "%")} | ${f(s.pass_pct_excluding_grounding, "%")} |`); }
L.push("", "Config B runs with grounding off, so its grounding cases cannot pass by design (they need tool docs in the prompt). They are counted in the overall rate and left out of the failure lists.");
L.push("");
L.push("## Pass rate per category", "");
L.push("| category | " + CONFIGS.filter((c) => summary.configs[c]).map((c) => `${c} pass %`).join(" | ") + " |");
L.push("|---|" + CONFIGS.filter((c) => summary.configs[c]).map(() => "---").join("|") + "|");
for (const cat of CATS) {
  const cells = CONFIGS.filter((c) => summary.configs[c]).map((c) => { const p = summary.configs[c].per_category[cat]; return p.total ? `${p.pass_pct}% (${p.passed}/${p.total}${p.skipped ? `, ${p.skipped} skipped` : ""})` : (p.skipped ? `skipped ${p.skipped}` : "not run"); });
  L.push(`| ${cat} | ${cells.join(" | ")} |`);
}
L.push("");
L.push("## Latency (model-based cases, ms)", "");
L.push("| config | warmup ms | n | p50 | p90 | p99 | max | avg LLM calls/case | cases with retry % |", "|---|---|---|---|---|---|---|---|---|");
for (const cfg of CONFIGS) { const s = summary.configs[cfg]; if (!s) continue; const o = s.latency_model_cases.overall; L.push(`| ${cfg} | ${f(s.warmup_ms)} | ${o.n} | ${f(o.p50)} | ${f(o.p90)} | ${f(o.p99)} | ${f(o.max)} | ${f(s.avg_llm_calls_model_cases)} | ${f(s.retry_rate_pct, "%")} |`); }
L.push("", "Per category (config A):", "", "| category | n | p50 | p90 | p99 | max |", "|---|---|---|---|---|---|");
if (summary.configs.A) for (const [cat, o] of Object.entries(summary.configs.A.latency_model_cases.per_category)) L.push(`| ${cat} | ${o.n} | ${f(o.p50)} | ${f(o.p90)} | ${f(o.p99)} | ${f(o.max)} |`);
L.push("");
L.push("## Cold start", "");
const cs = summary.cold_start;
if (cs?.measured) L.push(`First request after \`ollama stop\` (CLI wall time, incl. Node startup): ${cs.runs.map((r) => r.ms + " ms").join(", ")}.`);
else L.push(`${cs?.note ?? "not measured"}.`);
L.push("");
L.push("## CLI end-to-end latency", "", summary.cli_e2e ? `30 runs of \`whatcmd --raw -- <request>\` (warm model, incl. Node startup): p50 ${summary.cli_e2e.p50_ms} ms, p90 ${summary.cli_e2e.p90_ms} ms, max ${summary.cli_e2e.max_ms} ms (n=${summary.cli_e2e.n}).` : "not measured.", "");
L.push("## Grounding effect", "", "| config | fake tools pass % | real tools pass % |", "|---|---|---|");
for (const cfg of CONFIGS) { const s = summary.configs[cfg]; if (s) L.push(`| ${cfg} (grounding ${cfg === "B" ? "off" : "on"}) | ${f(s.grounding_effect.fake_tools.pass_pct, "%")} (${s.grounding_effect.fake_tools.passed}/${s.grounding_effect.fake_tools.total}) | ${f(s.grounding_effect.real_tools.pass_pct, "%")} (${s.grounding_effect.real_tools.passed}/${s.grounding_effect.real_tools.total}) |`); }
L.push("");
L.push("## missing_tool outcome breakdown", "", "| config | rejected | alternative | installs | warned | uses tool, no warning (fail) |", "|---|---|---|---|---|---|");
for (const cfg of CONFIGS) { const s = summary.configs[cfg]; if (!s) continue; const o = s.missing_tool_outcomes; L.push(`| ${cfg} | ${o.rejected ?? 0} | ${o.alternative ?? 0} | ${o.installs ?? 0} | ${o.warned ?? 0} | ${o.uses_tool_no_warning ?? 0} |`); }
L.push("");
L.push("## Stability", "", summary.stability ? `${summary.stability.sample_size} random model-based cases (seed ${summary.stability.seed}), each run ${summary.stability.runs_per_case} times with config A: ${summary.stability.identical_all_three} gave the same output all 3 times (${summary.stability.pct_identical}%).` : "not run.", "");
L.push("## Failures", "");
const bugs = CONFIGS.flatMap((c) => (summary.configs[c]?.product_bug_failures ?? []).map((x) => ({ ...x, cfg: c })));
const misses = CONFIGS.flatMap((c) => (summary.configs[c]?.model_miss_failures ?? []).map((x) => ({ ...x, cfg: c })));
const uniq = (list) => { const seen = new Map(); for (const x of list) { if (!seen.has(x.id)) seen.set(x.id, { ...x, configs: [x.cfg] }); else seen.get(x.id).configs.push(x.cfg); } return [...seen.values()]; };
const bugU = uniq(bugs), missU = uniq(misses);
const row = (x) => `| ${x.id} | ${JSON.stringify(x.input)} | ${x.expected} | ${JSON.stringify(x.got)}${x.error ? ` (${x.error})` : ""} | ${x.configs.join(",")} |`;
L.push(`### Product bugs (${bugU.length} case ids)`, "", "Failures in gate, risk-fn, config, cli, hook, plus crashes/exceptions, plus grounding cases where the tool docs never reached the prompt.", "", "| id | input | expected | got | configs |", "|---|---|---|---|---|");
L.push(...bugU.map(row), "");
L.push(`### Model misses (${missU.length} case ids)`, "", "| id | input | expected | got | configs |", "|---|---|---|---|---|");
L.push(...missU.map(row), "");
L.push("## Changes to tests", "", fs.existsSync(path.join(ROOT, "CHANGES_TO_TESTS.md")) ? fs.readFileSync(path.join(ROOT, "CHANGES_TO_TESTS.md"), "utf8") : "none", "");
fs.writeFileSync(path.join(RES, "report.md"), L.join("\n") + "\n");
console.log("wrote", path.join(RES, "summary.json"), "and", path.join(RES, "report.md"));
