import type { Profile } from "./env.js";

/**
 * OS-aware checks that a small model often gets wrong (mostly GNU vs macOS/BSD),
 * plus hints for tools that exist on one OS but not the other.
 */

export interface LintIssue {
  /** Short warning shown to the user if the problem survives the retry. */
  warning: string;
  /** Instruction given to the model on retry. */
  hint: string;
}

const BSD_RULES: [RegExp, LintIssue][] = [
  [/\bdate\b[^|;&]*\s(-d|--date)\b/, { warning: "uses GNU date -d (macOS date uses -v)", hint: "macOS date has no -d; use -v, e.g. date -v-30d +%F" }],
  [/\bstat\s+(-[a-zA-Z]+\s+)*(-c|--format)\b/, { warning: "uses GNU stat -c (macOS stat uses -f)", hint: "macOS stat has no -c; use stat -f, e.g. stat -f %z file" }],
  [/\bgrep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*P/, { warning: "uses grep -P (not on macOS)", hint: "macOS grep has no -P; use grep -E" }],
  [/\bxargs\s+(-[a-zA-Z]*\s+)*-r\b/, { warning: "uses GNU xargs -r", hint: "macOS xargs has no -r; drop it" }],
  [/\bfind\b[^|;&]*\s-printf\b/, { warning: "uses GNU find -printf", hint: "macOS find has no -printf; use -exec stat -f ... or -print" }],
  [/\b(ls|du|df|sort)\b[^|;&]*\s--[a-z]/, { warning: "uses GNU long options", hint: "macOS ls/du/df/sort take short options only (no --long-options)" }],
];

/** Equivalents to suggest when a tool is missing. */
const ALTERNATIVES: Record<string, Record<string, string>> = {
  macos: {
    free: "vm_stat, or: top -l 1 | grep PhysMem, or: sysctl hw.memsize",
    lsblk: "diskutil list",
    lscpu: "sysctl -n machdep.cpu.brand_string, sysctl hw.ncpu",
    nproc: "sysctl -n hw.ncpu",
    lsusb: "system_profiler SPUSBDataType",
    systemctl: "brew services (list|start|stop|restart) NAME, or launchctl",
    service: "brew services, or launchctl",
    journalctl: "log show --last 1h",
    ip: "ifconfig, or: route -n get default",
    "xdg-open": "open",
    xclip: "pbcopy / pbpaste",
    xsel: "pbcopy / pbpaste",
    pidof: "pgrep",
    ss: "lsof -iTCP -sTCP:LISTEN -n -P",
    netstat: "lsof -i -n -P",
    sha256sum: "shasum -a 256",
    md5sum: "md5",
    tac: "tail -r",
    apt: "brew",
    "apt-get": "brew",
  },
  linux: {
    netstat: "ss (e.g. ss -tulpn)",
    ifconfig: "ip addr",
    route: "ip route",
    traceroute: "tracepath",
    nslookup: "getent hosts, or dig",
    open: "xdg-open",
    pbcopy: "xclip -selection clipboard",
    pbpaste: "xclip -selection clipboard -o",
    sw_vers: "cat /etc/os-release",
    diskutil: "lsblk",
    "system_profiler": "lscpu / lsusb / lspci",
    brew: "the system package manager",
  },
};

export function lint(cmd: string, profile: Profile | undefined): LintIssue[] {
  if (profile?.userland !== "bsd") return [];
  return BSD_RULES.filter(([re]) => re.test(cmd)).map(([, issue]) => issue);
}

/** Safe, deterministic rewrites. Today: `sed -i 's/…'` → `sed -i '' 's/…'` on macOS. */
export function autofix(cmd: string, profile: Profile | undefined): string {
  if (profile?.userland !== "bsd") return cmd;
  return cmd.replace(/\bsed\s+-i\s+(?=['"]?(s|y)[^a-z]|-e\b|['"]?\d|['"]?\/)/g, "sed -i '' ");
}

export function alternativeFor(tool: string, profile: Profile | undefined): string | null {
  if (!profile) return null;
  return ALTERNATIVES[profile.os]?.[tool] ?? null;
}

/**
 * Signals that a request is about this computer. When the model answers NONE to such a
 * request, it gets a second chance; requests without these signals keep the NONE.
 */
const SHELL_WORDS = new RegExp(
  "\\b(" +
    [
      "files?", "folders?", "director(y|ies)", "disk space", "drives?", "partitions?", "mounted",
      "pid", "ports?", "dns", "ip address", "hostname", "ping", "wifi", "network",
      "cpu", "ram", "swap", "uptime", "kernel", "battery", "usb",
      "permissions?", "logged in", "sudo",
      "git", "commits?", "branch(es)?", "repo(sitory)?", "stash", "docker", "containers?",
      "cron", "daemon", "env(ironment)? var(iable)?s?",
      "archive", "zip", "tar", "unzip",
      "shell", "terminal", "bash", "zsh", "my (computer|machine|mac|laptop)", "this (computer|machine|mac|laptop)",
    ].join("|") +
    ")\\b",
  "i",
);

/** Prompt-injection phrasing: never treat as a task. */
export function isInjection(ask: string): boolean {
  return /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|prompt|rules|above)\b/i.test(ask);
}

/**
 * Commands that only do arithmetic or transform literal text ("echo 60/1.5 | bc", "echo hello | tr …")
 * are the model answering a question, unless the user asked for it in the shell.
 */
export function isCalculatorAnswer(original: string, ask: string): boolean {
  let cmd = original;
  if (/\b(shell|terminal|bash|zsh|command line|bc|awk|calculate in)\b/i.test(ask)) return false;
  // Inline arithmetic like "$(echo 240*15/100 | bc)" or "$((2+2))" counts as literal text.
  let prev = "";
  while (prev !== cmd) {
    prev = cmd;
    cmd = cmd.replace(/\$\(\s*(echo|printf)\s+[^$()`|]*\|\s*bc(\s+-l)?\s*\)/g, "N").replace(/\$\(\([^()]*\)\)/g, "N");
  }
  if (/^(echo|printf)\s+[^|$`<>]*$/.test(cmd) && cmd !== original) return true;
  if (/^expr\s/.test(cmd)) return true;
  // echo/printf of literal text (no variables or files) into calculators or text filters only
  const m = /^(echo|printf)\s+([^|$`<>]*?)\s*((\|\s*(bc|bc -l|tr|sed|awk|rev|cut|wc|python3?|perl)\b[^|<>]*)+)$/.exec(cmd);
  return Boolean(m && !/[$`]/.test(m[3]));
}

export function looksLikeShellTask(ask: string): boolean {
  if (isInjection(ask)) return false;
  return (
    SHELL_WORDS.test(ask) ||
    /\b[\w-]*[a-z][\w-]*\.[a-z][a-z0-9]{0,4}\b/i.test(ask) || // a filename like report.pdf (not "1.5")
    /(^|\s)[~/.][\w./-]*/.test(ask) || // a path
    /\b\d{1,3}(\.\d{1,3}){3}\b/.test(ask) || // an IP address
    /https?:\/\//.test(ask)
  );
}

/** Small models sometimes loop: "photos photos photos …" or "Rational::Rational::…". */
export function isDegenerate(cmd: string): boolean {
  const toks = cmd.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (toks.length < 16) return false;
  return new Set(toks).size / toks.length < 0.35;
}
