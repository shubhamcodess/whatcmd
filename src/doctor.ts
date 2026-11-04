import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cacheDir, DEFAULT_MODEL, loadConfig, saveStored, type Config } from "./config.js";
import { detectProfile, profileHeadline, type Profile } from "./env.js";
import { generate } from "./generate.js";
import { docFor } from "./ground.js";
import { getVersion, hasModel, isUp, listModels, pull, type ModelInfo } from "./ollama.js";
import { bashTooOld, installHook, isHookInstalled, isHookShell, rcFile } from "./shell.js";
import { ask, bold, canPrompt, confirm, cyan, dim, err, fail, formatBytes, green, info, ok, warn } from "./ui.js";
import { clearWhichCache, which } from "./util.js";

export const RECOMMENDED: { name: string; size: string; note: string }[] = [
  { name: DEFAULT_MODEL, size: "~1.0 GB", note: "recommended: most accurate in our tests, ~0.5 s per command on a laptop CPU" },
  { name: "qwen2.5-coder:0.5b", size: "~0.4 GB", note: "fastest, but much less accurate (62% vs 85% in our 500-case test); not recommended" },
  { name: "qwen2.5-coder:3b", size: "~1.9 GB", note: "for a GPU or fast CPU; slower, not benchmarked yet" },
];

const BASH_TOO_OLD =
  "Your bash is older than 4.0 (macOS ships 3.2), which can't host the /w shortcut. " +
  "Use zsh (the macOS default), or install a newer bash: brew install bash. You can still run: whatcmd <request>";

export interface DoctorOptions {
  /** Accept defaults without asking (start Ollama, download the configured model). Never runs the Ollama installer. */
  yes: boolean;
  /** Use/download this model instead of the configured one. */
  model?: string;
  refreshProfile: boolean;
  /** Called from init, which sets up the shell shortcut itself. */
  fromInit?: boolean;
}

function installCommand(p: Profile): string | null {
  if (p.os === "linux") return "curl -fsSL https://ollama.com/install.sh | sh";
  if (p.os === "macos" && which("brew")) return "brew install ollama";
  return null;
}

async function waitUp(host: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isUp(host)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function startServer(bin: string): string {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const log = path.join(cacheDir(), "ollama.log");
  const fd = fs.openSync(log, "a");
  spawn(bin, ["serve"], { detached: true, stdio: ["ignore", fd, fd] }).unref();
  return log;
}

async function chooseModel(installed: ModelInfo[], current: string): Promise<string> {
  err(bold("\nChoose a model for whatcmd:"));
  const options: string[] = [];
  for (const r of RECOMMENDED) {
    options.push(r.name);
    const have = hasModel(installed, r.name) ? green("downloaded") : r.size;
    err(`  ${options.length}) ${cyan(r.name.padEnd(20))} ${have.padEnd(12)} ${dim(r.note)}`);
  }
  for (const m of installed) {
    if (RECOMMENDED.some((r) => r.name === m.name) || /embed/i.test(m.name)) continue;
    options.push(m.name);
    err(`  ${options.length}) ${cyan(m.name.padEnd(20))} ${green("downloaded")}  ${dim(formatBytes(m.size))}`);
  }
  err(`  ${options.length + 1}) Type another Ollama model name`);
  const def = Math.max(1, options.indexOf(current) + 1);
  for (;;) {
    const a = await ask(`Choice [${def}]: `);
    if (!a) return options[def - 1];
    const n = Number(a);
    if (n >= 1 && n <= options.length) return options[n - 1];
    if (n === options.length + 1) {
      const name = await ask("Model name (see https://ollama.com/library): ");
      if (name) return name;
    } else if (!/^\d+$/.test(a)) return a; // they typed a model name directly
  }
}

export async function downloadModel(host: string, model: string): Promise<void> {
  err(`Downloading ${cyan(model)} …`);
  let last = "";
  await pull(host, model, (status, completed, total) => {
    const line = total && completed !== undefined ? `  ${status.slice(0, 30)} ${Math.floor((completed / total) * 100)}% of ${formatBytes(total)}` : `  ${status}`;
    if (line === last) return;
    last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[K${line}`);
  });
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  ok(`Downloaded ${model}`);
}

/** Returns true when everything needed to generate commands works. */
export async function doctor(opts: DoctorOptions): Promise<boolean> {
  let cfg: Config = loadConfig();
  const firstRun = !cfg.profile; // first run: let the user pick a model even if the default exists
  const interactive = canPrompt() && !opts.yes;
  err(bold("whatcmd doctor\n"));

  // 1. System profile: goes into every prompt so commands fit this OS and its installed tools.
  let profile = cfg.profile;
  if (!profile || opts.refreshProfile) {
    profile = detectProfile();
    saveStored({ profile });
  }
  ok(`System: ${profileHeadline(profile)}`);
  info(`installed tools the model may use: ${profile.installed.join(", ") || "none detected"}`);

  // 2. Ollama installed and running?
  let up = await isUp(cfg.host);
  let bin = which("ollama");
  if (!up && !bin) {
    fail("Ollama is not installed. whatcmd runs models locally through Ollama.");
    const cmd = installCommand(profile);
    if (cmd) info(`install it with:  ${cmd}`);
    info("or download it from https://ollama.com/download");
    if (cmd && interactive && (await confirm(`Run "${cmd}" now?`, false))) {
      spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
      clearWhichCache();
      bin = which("ollama");
      up = await waitUp(cfg.host, 8000);
    }
    if (!bin && !up) {
      info("then run `whatcmd doctor` again.");
      return false;
    }
  }
  if (!up && bin) {
    warn(`Ollama is installed but not running at ${cfg.host}`);
    if (opts.yes || (interactive && (await confirm("Start it in the background now?", true)))) {
      const log = startServer(bin);
      up = await waitUp(cfg.host, 10000);
      if (!up) fail(`Ollama did not start; see ${log}`);
    } else info("start it with:  ollama serve");
    if (!up) return false;
  }
  ok(`Ollama ${await getVersion(cfg.host)} is running at ${cfg.host}`);

  // 3. Model downloaded?
  const installed = await listModels(cfg.host);
  let model = opts.model ?? cfg.model;
  if (!hasModel(installed, model) || (interactive && firstRun && !opts.model)) {
    if (!hasModel(installed, model)) warn(`Model ${model} is not downloaded yet`);
    if (interactive) model = await chooseModel(installed, model);
    else if (!opts.yes) {
      info(`download it with:  whatcmd use ${model}   (or run \`whatcmd doctor\` in a terminal to pick one)`);
      return false;
    }
    if (!hasModel(installed, model)) await downloadModel(cfg.host, model);
  }
  if (model !== cfg.model) saveStored({ model });
  cfg = loadConfig();
  ok(`Model ${model} is ready`);

  // Pre-load docs of installed tools so the first request never waits on a slow `--help`.
  let docs = 0;
  for (const tool of profile.installed) {
    const p = which(tool);
    if (p && docFor(tool, p)) docs++;
  }
  ok(`Cached local docs for ${docs} installed tools`);

  // 4. Real test request (first one also loads the model into memory).
  let t = performance.now();
  const r = await generate("list files in this folder", cfg);
  const loadMs = Math.round(performance.now() - t);
  t = performance.now();
  const r2 = await generate("show free disk space", cfg);
  const ms = Math.round(performance.now() - t);
  if (r.kind === "command" && r2.kind === "command") {
    ok(`Test request answered in ${ms} ms ${dim(`(first call, incl. loading the model: ${loadMs} ms)`)}`);
    info(`"show free disk space" → ${r2.command}`);
  } else warn(`Model answered, but the test output was rejected (${r.kind === "rejected" ? r.reason : r2.kind === "rejected" ? r2.reason : ""}). Try another model with \`whatcmd use\`.`);

  // 5. Shell shortcut.
  if (opts.fromInit) return true;
  if (profile.shell === "bash" && bashTooOld()) warn(BASH_TOO_OLD);
  else if (isHookShell(profile.shell)) {
    if (isHookInstalled(profile.shell, profile.os)) ok(`Shell shortcut is set up: type ${cyan(`${cfg.prefix} <request>`)} at any prompt`);
    else warn(`Shell shortcut not set up yet. Run \`whatcmd init\` to enable ${cfg.prefix} <request>`);
  } else warn(`${profile.shell} has no ${cfg.prefix} shortcut yet (bash and zsh do). Use: whatcmd <request>`);
  return true;
}

/** First-time setup: doctor + shell shortcut. */
export async function init(opts: DoctorOptions): Promise<boolean> {
  const ready = await doctor({ ...opts, refreshProfile: true, fromInit: true });
  const cfg = loadConfig();
  const profile = cfg.profile ?? detectProfile();
  const shell = profile.shell;
  err("");
  if (!isHookShell(shell)) {
    warn(`The ${cfg.prefix} shortcut supports bash and zsh; your shell is ${shell}. You can still run: whatcmd <request>`);
    return ready;
  }
  if (shell === "bash" && bashTooOld()) {
    warn(BASH_TOO_OLD);
    return ready;
  }
  const rc = rcFile(shell, profile.os);
  if (isHookInstalled(shell, profile.os)) {
    installHook(shell, cfg.prefix, profile.os); // refresh the hook file
    ok(`Shell shortcut already in ${rc}`);
  } else if (opts.yes || !canPrompt() || (await confirm(`Add the ${cfg.prefix} shortcut to ${rc}?`, true))) {
    installHook(shell, cfg.prefix, profile.os);
    ok(`Added the shortcut to ${rc}`);
  } else {
    info(`Skipped. To add it yourself, put this in ${rc}:  eval "$(whatcmd shell ${shell})"`);
    return ready;
  }
  err(`\n${bold("Done.")} Open a new terminal (or run ${cyan(`source ${rc}`)}), then type:`);
  err(`  ${cyan(`${cfg.prefix} find files bigger than 100MB`)}   and press Enter`);
  err(dim("  The command appears on your prompt. Press Enter again to run it, or edit it first."));
  return ready;
}
