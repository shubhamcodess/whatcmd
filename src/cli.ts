#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ConfigError, DEFAULTS, SETTABLE, configPath, loadConfig, readStored, saveStored, setKey, unsetKey, writeStored,
} from "./config.js";
import { OllamaError } from "./ollama.js";
import { bold, canPrompt, confirm, cyan, dim, err, red, yellow } from "./ui.js";

const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `${bold("cmdkit")} — plain English in, shell command out. Runs locally on Ollama.

${bold("Usage")}
  /cmdkit <request>          at any bash/zsh prompt (after \`cmdkit init\`): the command
                             replaces your line; press Enter again to run it
  cmdkit <request>           print the command and offer to run it
  cmdkit init                first-time setup: checks Ollama, picks a model, adds /cmdkit
  cmdkit doctor              check everything works (Ollama, model, speed, shell shortcut)
  cmdkit use <model>         switch model (downloads it if needed)
  cmdkit models              list downloaded Ollama models
  cmdkit config              show settings
  cmdkit config set <key> <value> | get <key> | unset <key> | path | reset
  cmdkit profile [--refresh] show (or re-detect) the system info given to the model
  cmdkit shell bash|zsh      print the shell hook (to add it yourself)
  cmdkit uninstall           remove the /cmdkit shortcut from your shell config

${bold("Options")}
  --raw          print only the command (for scripts and the shell hook)
  --debug        show grounding, prompts and timings
  --yes, -y      accept defaults without asking (doctor/init)
  --model=NAME   use this model for one request (or with doctor/init: switch to it)
  --             everything after this is the request

${bold("Environment")}
  CMDKIT_MODEL, CMDKIT_HOST (or OLLAMA_HOST), CMDKIT_CONFIG_DIR, NO_COLOR

${bold("Examples")}
  cmdkit find files bigger than 100MB
  cmdkit "what's using port 8080"
  cmdkit config set model qwen2.5-coder:0.5b
  cmdkit config set notes "prefer ripgrep over grep"
`;

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  let literal = false;
  for (const a of argv) {
    if (literal) rest.push(a);
    else if (a === "--") literal = true;
    else if (/^--[a-z-]+=/.test(a)) {
      const i = a.indexOf("=");
      values[a.slice(2, i)] = a.slice(i + 1);
    } else if (/^(--[a-z-]+|-[hvy])$/.test(a)) flags.add(a);
    else rest.push(a);
  }
  return { flags, values, rest, literal };
}

/** Subcommands only match their exact shape, so "cmdkit init a git repo" is still a request. */
function subcommand(rest: string[]): string | null {
  const [a, b] = rest;
  const n = rest.length;
  if (["init", "doctor", "models", "profile", "uninstall"].includes(a) && n === 1) return a;
  if (a === "config" && (n === 1 || ["list", "get", "set", "unset", "path", "reset"].includes(b))) return a;
  if (a === "use" && n === 2) return a;
  if (a === "shell" && n === 2 && ["bash", "zsh"].includes(b)) return a;
  return null;
}

function explainOllamaError(e: OllamaError, model: string): string {
  if (e.code === "unreachable") return `${e.message}. Is Ollama running? Run: cmdkit doctor`;
  if (e.code === "model_missing") return `${e.message}. Run: cmdkit use ${model}`;
  return e.message;
}

async function runRequest(ask: string, opts: { raw: boolean; debug: boolean; model?: string }): Promise<number> {
  const { generate } = await import("./generate.js");
  const cfg = loadConfig();
  if (opts.model) cfg.model = opts.model;
  let res;
  try {
    res = await generate(ask, cfg);
  } catch (e) {
    if (e instanceof OllamaError) {
      err(`cmdkit: ${explainOllamaError(e, cfg.model)}`);
      return 1;
    }
    throw e;
  }
  if (opts.debug) {
    err(dim(`model: ${cfg.model}  timings: ${JSON.stringify(res.debug.timings)}`));
    for (const n of res.debug.groundNotes) err(dim(`grounding: ${n}`));
    for (const r of res.debug.refs) err(dim(`grounding [${r.name} via ${r.source}]:\n${r.text}`));
    if (res.debug.retries.length) err(dim(`retries: ${res.debug.retries.join(", ")}`));
    err(dim(`raw outputs: ${JSON.stringify(res.debug.outputs)}`));
  }
  if (res.kind === "rejected") {
    const why = res.reason === "empty" ? "empty request" : "not a shell task, nothing generated";
    err(opts.raw ? `cmdkit: ${why}` : yellow(`cmdkit: ${why}`));
    return 2;
  }
  if (opts.raw) {
    process.stdout.write(res.command + "\n");
    for (const w of res.warnings) err(`cmdkit: ⚠ ${w}`);
    return 0;
  }
  process.stdout.write(bold(cyan(res.command, process.stdout), process.stdout) + "\n");
  for (const w of res.warnings) err(yellow(`⚠ ${w}`));
  if (!canPrompt() || !process.stdout.isTTY) return 0;
  if (!(await confirm("Run it?", false))) return 0;
  const shell = process.env.SHELL || "/bin/sh";
  return spawnSync(shell, ["-c", res.command], { stdio: "inherit" }).status ?? 1;
}

async function configCommand(rest: string[]): Promise<number> {
  const [, action = "list", key, ...valueParts] = rest;
  const value = valueParts.join(" ");
  if (action === "path") {
    process.stdout.write(configPath() + "\n");
    return 0;
  }
  if (action === "list") {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const stored = readStored() as Record<string, unknown>;
    err(dim(`# ${configPath()}`));
    for (const k of Object.keys(SETTABLE)) {
      const src = process.env[`CMDKIT_${k.toUpperCase()}`] ? "env" : k in stored ? "" : "default";
      process.stdout.write(`${k} = ${JSON.stringify(cfg[k])}${src ? dim(`  (${src})`, process.stdout) : ""}\n`);
    }
    return 0;
  }
  if (action === "get") {
    if (!key || !SETTABLE[key]) throw new ConfigError(`Usage: cmdkit config get <${Object.keys(SETTABLE).join("|")}>`);
    process.stdout.write(String((loadConfig() as unknown as Record<string, unknown>)[key]) + "\n");
    return 0;
  }
  if (action === "set") {
    if (!key || !valueParts.length) throw new ConfigError("Usage: cmdkit config set <key> <value>");
    setKey(key, value);
    if (key === "prefix") (await import("./shell.js")).refreshHookFiles(value);
    err(`${key} = ${JSON.stringify((loadConfig() as unknown as Record<string, unknown>)[key])}`);
    if (key === "prefix") err(dim("Open a new terminal for the new prefix to take effect."));
    if (key === "model") {
      const { listModels, hasModel } = await import("./ollama.js");
      try {
        if (!hasModel(await listModels(loadConfig().host), value)) err(yellow(`${value} is not downloaded yet. Run: cmdkit use ${value}`));
      } catch {}
    }
    return 0;
  }
  if (action === "unset") {
    if (!key) throw new ConfigError("Usage: cmdkit config unset <key>");
    unsetKey(key);
    err(`${key} reset to default (${JSON.stringify((DEFAULTS as unknown as Record<string, unknown>)[key])})`);
    return 0;
  }
  if (action === "reset") {
    const { profile } = readStored();
    writeStored(profile ? { profile } : {});
    err("Settings reset to defaults (system profile kept).");
    return 0;
  }
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const { flags, values, rest, literal } = parseArgs(argv);
  if (flags.has("--version") || flags.has("-v")) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const sub = literal ? null : subcommand(rest);
  if (!sub && (flags.has("--help") || flags.has("-h") || rest.length === 0)) {
    process.stdout.write(HELP);
    return rest.length === 0 && !flags.has("--help") && !flags.has("-h") ? 1 : 0;
  }
  const yes = flags.has("--yes") || flags.has("-y");

  switch (sub) {
    case "init":
    case "doctor": {
      const d = await import("./doctor.js");
      const opts = { yes, model: values.model, refreshProfile: flags.has("--refresh") };
      return (await (sub === "init" ? d.init(opts) : d.doctor(opts))) ? 0 : 1;
    }
    case "config":
      return configCommand(rest);
    case "use": {
      const model = rest[1];
      const { listModels, hasModel } = await import("./ollama.js");
      const cfg = loadConfig();
      if (!hasModel(await listModels(cfg.host), model)) {
        if (!yes && canPrompt() && !(await confirm(`${model} is not downloaded. Download it now?`, true))) return 1;
        await (await import("./doctor.js")).downloadModel(cfg.host, model);
      }
      saveStored({ model });
      err(`Now using ${cyan(model)}`);
      return 0;
    }
    case "models": {
      const { listModels, sameModel } = await import("./ollama.js");
      const { formatBytes } = await import("./ui.js");
      const cfg = loadConfig();
      const models = await listModels(cfg.host);
      if (!models.length) err("No models downloaded. Run: cmdkit doctor");
      for (const m of models)
        process.stdout.write(`${sameModel(m.name, cfg.model) ? "*" : " "} ${m.name.padEnd(28)} ${formatBytes(m.size)}\n`);
      return 0;
    }
    case "profile": {
      const { detectProfile, profilePrompt } = await import("./env.js");
      let profile = loadConfig().profile;
      if (!profile || flags.has("--refresh")) {
        profile = detectProfile();
        saveStored({ profile });
      }
      process.stdout.write(profilePrompt(profile) + "\n");
      err(dim(`detected ${profile.detectedAt}; re-detect with: cmdkit profile --refresh`));
      return 0;
    }
    case "shell": {
      const { hookScript } = await import("./shell.js");
      process.stdout.write(hookScript(rest[1] as "bash" | "zsh", loadConfig().prefix));
      return 0;
    }
    case "uninstall": {
      const { uninstallHook } = await import("./shell.js");
      const { detectProfile } = await import("./env.js");
      const osName = (loadConfig().profile ?? detectProfile()).os;
      const removed = ["bash", "zsh"].filter((s) => uninstallHook(s as "bash" | "zsh", osName));
      err(removed.length ? `Removed the shortcut from your ${removed.join(" and ")} config.` : "No shortcut was installed.");
      err(dim("To remove cmdkit itself: npm uninstall -g @shubhamcodess/cmdkit"));
      return 0;
    }
  }

  return runRequest(rest.join(" "), { raw: flags.has("--raw"), debug: flags.has("--debug"), model: values.model });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ConfigError) err(`cmdkit: ${e.message}`);
    else if (e instanceof OllamaError) err(`cmdkit: ${explainOllamaError(e, loadConfig().model)}`);
    else err(red(`cmdkit: ${(e as Error)?.stack ?? e}`));
    process.exit(1);
  },
);
