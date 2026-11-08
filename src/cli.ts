#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ConfigError, DEFAULTS, SETTABLE, configPath, loadConfig, readStored, saveStored, setKey, unsetKey, writeStored,
} from "./config.js";
import { OllamaError } from "./ollama.js";
import { ask as ask_, bold, canPrompt, confirm, cyan, dim, err, red, yellow } from "./ui.js";

const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `${bold("whatcmd")} — plain English in, shell command out. Runs locally on Ollama.

${bold("Usage")}
  /w <request>               at any bash/zsh prompt (after \`whatcmd init\`): the command
                             replaces your line; press Enter again to run it
  /w+ <change>               refine the last command ("only pdfs", "fix that"); up to 5 times
  whatcmd <request>           print the command and offer to run it
  whatcmd init                first-time setup: checks Ollama, picks a model, adds /w
  whatcmd doctor              check everything works (Ollama, model, speed, shell shortcut)
  whatcmd use <model>         switch model (downloads it if needed)
  whatcmd models              list downloaded Ollama models
  whatcmd config              show settings
  whatcmd config set <key> <value> | get <key> | unset <key> | path | reset
  whatcmd profile [--refresh] show (or re-detect) the system info given to the model
  whatcmd shell bash|zsh      print the shell hook (to add it yourself)
  whatcmd uninstall           remove the /w shortcut from your shell config

${bold("Options")}
  --raw          print only the command (for scripts and the shell hook)
  --refine       apply the request as a change to this terminal's last command
  --debug        show grounding, prompts and timings
  --web          look up docs on the web for this request (needs tiny-browse)
  --no-web       stay fully local for this request
  --yes, -y      accept defaults without asking (doctor/init)
  --model=NAME   use this model for one request (or with doctor/init: switch to it)
  --             everything after this is the request

${bold("Environment")}
  WHATCMD_MODEL, WHATCMD_HOST (or OLLAMA_HOST), WHATCMD_WEB=1|0, WHATCMD_CONFIG_DIR, NO_COLOR

${bold("Examples")}
  whatcmd find files bigger than 100MB
  whatcmd "what's using port 8080"
  whatcmd config set model qwen2.5-coder:0.5b
  whatcmd config set notes "prefer ripgrep over grep"
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

/** Subcommands only match their exact shape, so "whatcmd init a git repo" is still a request. */
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
  if (e.code === "unreachable") return `${e.message}. Is Ollama running? Run: whatcmd doctor`;
  if (e.code === "model_missing") return `${e.message}. Run: whatcmd use ${model}`;
  return e.message;
}

interface RequestOptions {
  raw: boolean;
  debug: boolean;
  model?: string;
  /** Per-request override of the `web` setting. */
  web?: boolean;
  refine: boolean;
  /** Terminal session id (the shell's PID); defaults to the parent process. */
  session?: string;
  lastCmd?: string;
  lastStatus?: number;
}

async function runRequest(ask: string, opts: RequestOptions): Promise<number> {
  const { generate } = await import("./generate.js");
  const { loadSession, saveSession, refineBase, MAX_REFINES } = await import("./session.js");
  const cfg = loadConfig();
  if (opts.model) cfg.model = opts.model;
  if (opts.web !== undefined) cfg.web = opts.web;
  const sid = opts.session || String(process.ppid);

  let session = opts.refine ? loadSession(sid) : null;
  if (opts.refine && !session) {
    err(`whatcmd: nothing to refine yet. Start with: ${cfg.prefix} <request>`);
    return 2;
  }
  let lastCmd = opts.lastCmd;
  let lastStatus = opts.lastStatus;
  let change = ask;

  for (;;) {
    if (session && session.turns >= MAX_REFINES) {
      err(`whatcmd: refined ${MAX_REFINES} times. Start fresh: ${cfg.prefix} <full request>`);
      return 2;
    }
    const refine = session
      ? (() => {
          const b = refineBase(session.command, lastCmd, lastStatus, session.lastSeen);
          return { originalAsk: session.ask, base: b.command, status: b.status };
        })()
      : undefined;

    let res;
    try {
      res = await generate(change, cfg, refine);
    } catch (e) {
      if (e instanceof OllamaError) {
        err(`whatcmd: ${explainOllamaError(e, cfg.model)}`);
        return 1;
      }
      throw e;
    }
    if (opts.debug) {
      err(dim(`model: ${cfg.model}  timings: ${JSON.stringify(res.debug.timings)}`));
      if (refine) err(dim(`refining: ${JSON.stringify(refine)}`));
      for (const n of res.debug.groundNotes) err(dim(`grounding: ${n}`));
      for (const n of res.debug.webNotes) err(dim(n));
      for (const r of res.debug.refs) err(dim(`grounding [${r.name} via ${r.source}${r.url ? ` ${r.url}` : ""}]:\n${r.text}`));
      if (res.debug.retries.length) err(dim(`retries: ${res.debug.retries.join(", ")}`));
      err(dim(`raw outputs: ${JSON.stringify(res.debug.outputs)}`));
    }
    if (res.kind === "rejected") {
      const why = res.reason === "empty" ? "empty request" : "not a shell task, nothing generated";
      err(opts.raw ? `whatcmd: ${why}` : yellow(`whatcmd: ${why}`));
      return 2;
    }

    const lastSeen = lastCmd?.trim();
    session = refine
      ? { ask: `${refine.originalAsk}; ${change.trim()}`, command: res.command, turns: (session?.turns ?? 0) + 1, lastSeen, at: 0 }
      : { ask: change.trim(), command: res.command, turns: 0, lastSeen, at: 0 };
    saveSession(sid, session);

    const webRef = res.debug.refs.find((r) => r.source === "web");
    const webNote = webRef ? `used web docs from ${webRef.url ? new URL(webRef.url).hostname : "a web search"}` : "";
    if (opts.raw) {
      process.stdout.write(res.command + "\n");
      if (webNote) err(`whatcmd: ${webNote}`);
      for (const w of res.warnings) err(`whatcmd: ⚠ ${w}`);
      if (refine) err(`whatcmd: refinement ${session.turns}/${MAX_REFINES}`);
      return 0;
    }
    process.stdout.write(bold(cyan(res.command, process.stdout), process.stdout) + "\n");
    if (webNote) err(dim(webNote));
    for (const w of res.warnings) err(yellow(`⚠ ${w}`));
    if (!canPrompt() || !process.stdout.isTTY) return 0;

    const left = MAX_REFINES - session.turns;
    const choice = (await ask_(`[r]un, re[f]ine${left < MAX_REFINES ? ` (${left} left)` : ""}, [q]uit? `)).toLowerCase();
    if (choice === "r" || choice === "run") {
      const shell = process.env.SHELL || "/bin/sh";
      return spawnSync(shell, ["-c", res.command], { stdio: "inherit" }).status ?? 1;
    }
    if (choice !== "f" && choice !== "refine") return 0;
    change = await ask_("Change: ");
    if (!change.trim()) return 0;
    lastCmd = undefined;
    lastStatus = undefined;
  }
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
      const src = process.env[`WHATCMD_${k.toUpperCase()}`] ? "env" : k in stored ? "" : "default";
      process.stdout.write(`${k} = ${JSON.stringify(cfg[k])}${src ? dim(`  (${src})`, process.stdout) : ""}\n`);
    }
    return 0;
  }
  if (action === "get") {
    if (!key || !SETTABLE[key]) throw new ConfigError(`Usage: whatcmd config get <${Object.keys(SETTABLE).join("|")}>`);
    process.stdout.write(String((loadConfig() as unknown as Record<string, unknown>)[key]) + "\n");
    return 0;
  }
  if (action === "set") {
    if (!key || !valueParts.length) throw new ConfigError("Usage: whatcmd config set <key> <value>");
    setKey(key, value);
    if (key === "prefix") (await import("./shell.js")).refreshHookFiles(value);
    err(`${key} = ${JSON.stringify((loadConfig() as unknown as Record<string, unknown>)[key])}`);
    if (key === "prefix") err(dim("Open a new terminal for the new prefix to take effect."));
    if (key === "model") {
      const { listModels, hasModel } = await import("./ollama.js");
      try {
        if (!hasModel(await listModels(loadConfig().host), value)) err(yellow(`${value} is not downloaded yet. Run: whatcmd use ${value}`));
      } catch {}
    }
    return 0;
  }
  if (action === "unset") {
    if (!key) throw new ConfigError("Usage: whatcmd config unset <key>");
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
      if (!models.length) err("No models downloaded. Run: whatcmd doctor");
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
      err(dim(`detected ${profile.detectedAt}; re-detect with: whatcmd profile --refresh`));
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
      err(dim("To remove whatcmd itself: npm uninstall -g whatcmd"));
      return 0;
    }
  }

  const status = values["last-status"] !== undefined ? Number(values["last-status"]) : undefined;
  return runRequest(rest.join(" "), {
    raw: flags.has("--raw"),
    debug: flags.has("--debug"),
    model: values.model,
    web: flags.has("--no-web") ? false : flags.has("--web") ? true : undefined,
    refine: flags.has("--refine"),
    session: values.session,
    lastCmd: values["last-cmd"],
    lastStatus: Number.isFinite(status) ? status : undefined,
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ConfigError) err(`whatcmd: ${e.message}`);
    else if (e instanceof OllamaError) err(`whatcmd: ${explainOllamaError(e, loadConfig().model)}`);
    else err(red(`whatcmd: ${(e as Error)?.stack ?? e}`));
    process.exit(1);
  },
);
