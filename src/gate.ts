import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { which } from "./util.js";

/**
 * The gate decides whether model output is a real, usable shell command.
 * Anything that is not (a NONE answer, chat text, unparseable output) produces nothing.
 */

export const BUILTINS = new Set(
  (
    "alias bg bind break builtin caller cd command compgen complete continue declare dirs disown echo enable " +
    "eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf " +
    "pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset " +
    "ulimit umask unalias unset wait . : [ [[ ]] if then else elif fi for while until do done case esac in " +
    "function select time { } ! coproc"
  ).split(" "),
);

/** Prefixes that run another command; we skip them to find the real one. */
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "nice", "ionice", "command", "exec", "builtin", "time"]);
/** Wrapper options that take a value, e.g. `nice -n 10 cmd`, `sudo -u bob cmd`. */
const WRAPPER_FLAGS_WITH_ARG: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-t"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  exec: new Set(["-a"]),
};

export type RejectReason = "empty" | "not-a-shell-task" | "unparseable" | "chat-reply";

export type Verdict =
  | { ok: true; command: string; missing: string[]; risks: string[] }
  | { ok: false; reason: RejectReason };

/** Pull the command out of model output: drop code fences, "$ " prompts and stray backticks. */
export function extractCommand(raw: string): string {
  const line = raw
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("```"));
  if (!line) return "";
  return line
    .replace(/^(command|cmd)\s*:\s*/i, "")
    .replace(/^\$\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
}

/** Split a command line into pipeline/list segments, respecting quotes. */
export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += ch + cmd[++i];
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      // keep redirections like 2>&1, >&2, &> intact
      if (ch === "&" && (/[<>]$/.test(cur) || cmd[i + 1] === ">")) {
        cur += ch;
        continue;
      }
      out.push(cur);
      cur = "";
      if (cmd[i + 1] === ch || (ch === "|" && cmd[i + 1] === "&")) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
  return segment.match(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"\\])*")+/g) ?? [];
}

/** The program each segment runs (after skipping sudo/env/VAR=x and similar). */
export function commandWords(cmd: string): string[] {
  const words: string[] = [];
  for (const seg of splitSegments(cmd)) {
    const toks = tokenize(seg.replace(/^[({!\s]+/, ""));
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      if (WRAPPERS.has(t)) {
        words.push(t);
        i++;
        while (i < toks.length && (toks[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))) {
          if (WRAPPER_FLAGS_WITH_ARG[t]?.has(toks[i])) i++;
          i++;
        }
        continue;
      }
      words.push(t.replace(/^['"]|['"]$/g, ""));
      break; // for xargs/timeout/watch only the wrapper itself is checked
    }
  }
  return words;
}

export function parses(cmd: string): boolean {
  const sh = which("bash") ? "bash" : which("sh") ? "sh" : null;
  if (!sh) return true;
  const r = spawnSync(sh, ["-n", "-c", cmd], { stdio: "ignore", timeout: 1000 });
  return r.status === 0;
}

export function commandExists(word: string): boolean {
  if (BUILTINS.has(word)) return true;
  if (word.startsWith("~")) return true; // user path; can't resolve reliably
  if (word.includes("/")) {
    try {
      fs.accessSync(word);
      return true;
    } catch {
      return word.startsWith("./") || word.startsWith("../"); // a script the user may be about to create
    }
  }
  return which(word) !== null;
}

const RISKS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\/\*)(\s|$)/, "deletes your whole system or home folder"],
  [/\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rR]|--recursive)/, "deletes files recursively"],
  [/\bdd\b[^|;&]*\bof=/, "dd overwrites the target file or disk"],
  [/\bmkfs(\.\w+)?\b|\bwipefs\b|\bfdisk\b|\bparted\b/, "formats or repartitions a disk"],
  [/>\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/, "writes directly to a disk device"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb: will freeze the machine"],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*([0-7]?[0-7]{2}[2367]\b|[ugoa]*[ao][ugoa]*\+[rwxXst]*w)/, "makes files writable by everyone"],
  [/\bch(own|mod)\s+(-[a-zA-Z]*R|--recursive)/, "changes ownership/permissions recursively"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "shuts down or restarts the machine"],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(ba|z|da)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b|(\b(ba|z|da)?sh|\bsource|^\.)\s+<\(\s*(curl|wget)\b/, "runs a script downloaded from the internet"],
  [/\bgit\s+(push\b[^|;&]*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)/, "discards git history or local changes"],
  [/\bkill(all)?\s+(-9|-KILL)\s+-1\b/, "kills all your processes"],
  [/\bsudo\b/, "runs as root"],
  [/\/path\/to\b|<[a-z_-]+>|\b(YOUR|your)_[A-Za-z_]+|\bPID\b|\byour-[a-z-]+/, "contains a placeholder: edit it before running"],
];

export function riskWarnings(cmd: string): string[] {
  const out: string[] = [];
  for (const [re, msg] of RISKS) {
    if (!re.test(cmd)) continue;
    if (msg === "deletes files recursively" && out.includes("deletes your whole system or home folder")) continue;
    out.push(msg);
  }
  return out;
}

export function check(raw: string, exists: (w: string) => boolean = commandExists): Verdict {
  const command = extractCommand(raw);
  if (!command) return { ok: false, reason: "empty" };
  if (/^NONE\b/i.test(command)) return { ok: false, reason: "not-a-shell-task" };
  if (!parses(command)) return { ok: false, reason: "unparseable" };
  const words = commandWords(command);
  const segments = splitSegments(command);
  if (segments.length === 1 && /^(echo|printf)$/.test(words[0] ?? "") && !/[$`>]/.test(command))
    return { ok: false, reason: "chat-reply" };
  const missing = [...new Set(words.filter((w) => !exists(w)))];
  return { ok: true, command, missing, risks: riskWarnings(command) };
}

/** A missing first word that doesn't even look like a program name is prose, not a command. */
export function looksLikeProgramName(word: string): boolean {
  return /^[a-z][a-z0-9._+-]*$/.test(word);
}
