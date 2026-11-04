import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "./config.js";
import type { Profile } from "./env.js";
import { run, which } from "./util.js";

/**
 * Grounding: when the request mentions a tool or package that is installed on this machine,
 * pull the relevant lines of its local docs (man page or --help, or package metadata)
 * and give them to the model, so it uses flags that really exist in *your* version.
 */

export interface Reference {
  name: string;
  source: "man" | "help" | "package";
  text: string;
}

// Words that are ordinary English in requests (some are also program names).
const STOP = new Set(
  (
    "a an the and or but if of to in on at by for with from into onto out up down over under about than then " +
    "this that these those it its is are was were be been do does did done can could should would will shall " +
    "i me my mine you your we our they them their he she his her what which who whom whose where when why how " +
    "all any each every some many much more most less least few no not only just also very too so here there " +
    "please show list display print get give find search look see check tell make create new delete remove " +
    "count number size sizes big bigger biggest large larger largest small smaller latest last first lines line " +
    "file files folder folders directory directories dir dirs current recursively recursive inside within " +
    "named called using use used run running start stop restart open close install installed update upgrade " +
    "version info details process processes port ports memory disk space usage free used total time today " +
    "week day days hour hours minute minutes ago older newer old word words text string contains containing " +
    "between same different every everything something nothing all one two three ten hidden human readable " +
    "format convert change rename move copy kill want need like way ok thanks hi hello mb gb kb"
  ).split(" "),
);

// Tools every model knows well; grounding them costs prompt time for no gain.
const COMMON = new Set(
  (
    "ls cd cp mv rm mkdir rmdir find grep sed awk cat head tail sort uniq wc cut tr xargs tar gzip gunzip zip " +
    "unzip chmod chown ln touch echo printf ps kill pkill killall top free df du date ssh scp curl wget git " +
    "ping which whoami id env export less more diff stat mount umount sudo apt apt-get yum dnf brew pacman " +
    "man history clear sh bash zsh"
  ).split(" "),
);

// Never execute these with --help (some ignore it and act). Their man pages are still used.
const NO_EXEC = new Set(
  (
    "reboot shutdown halt poweroff init telinit rm dd shred wipefs kill killall pkill fdisk parted sudo su " +
    "login passwd yes cat tee sh bash zsh fish dash python python3 node perl ruby nc telnet ssh"
  ).split(" "),
);

export function candidates(ask: string): string[] {
  const toks = ask.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*/g) ?? [];
  const out: string[] = [];
  for (let t of toks) {
    t = t.replace(/\.+$/, "");
    if (t.length < 2 || STOP.has(t) || COMMON.has(t) || /^\d+[a-z]{0,2}$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function stems(text: string): Set<string> {
  const s = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) if (!STOP.has(w)) s.add(w.slice(0, 5));
  return s;
}

/** Keep the description, the usage line, and the option lines that match the request. */
export function relevantExcerpt(doc: string, ask: string, maxChars = 900): string {
  const lines = doc.replace(/.\x08/g, "").split("\n");
  const after = (re: RegExp) => {
    const i = lines.findIndex((l) => re.test(l.trim()));
    return i >= 0 ? (lines.slice(i + 1).find((l) => l.trim()) ?? "").trim() : "";
  };
  const description = after(/^NAME$/);
  const usage = after(/^SYNOPSIS$/) || (lines.find((l) => /^\s*usage:/i.test(l)) ?? "").trim();

  const chunks: { i: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const opt = /^(\s*)-{1,2}[A-Za-z0-9]/.exec(l);
    const sub = /^(\s{2,})[a-z][a-z0-9-]+\s{2,}\S/.exec(l); // "  ps        List containers"
    const m = opt ?? sub;
    if (!m) continue;
    const indent = m[1].length;
    let text = l.trim();
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const n = lines[j];
      if (!n.trim() || /^\s*-{1,2}[A-Za-z0-9]/.test(n)) break;
      if (n.length - n.trimStart().length <= indent) break;
      text += " " + n.trim();
    }
    chunks.push({ i, text: text.replace(/\s+/g, " ") });
  }

  const want = stems(ask);
  const scored = chunks
    .map((c) => ({ ...c, score: [...stems(c.text)].filter((s) => want.has(s)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 8)
    .sort((a, b) => a.i - b.i);
  const picked = scored.length ? scored : chunks.slice(0, 6);

  const parts = [description || (usage ? "" : (lines.find((l) => l.trim()) ?? "").trim()), usage && `Usage: ${usage.replace(/^usage:\s*/i, "")}`]
    .filter(Boolean)
    .concat(picked.map((c) => c.text));
  let out = "";
  for (const p of parts) {
    if (out.length + p.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + p;
  }
  return out;
}

function cacheFile(name: string, binPath: string): string {
  let key = `v2-${name}`; // bump the version to invalidate caches when doc extraction changes
  try {
    key += "-" + Math.floor(fs.statSync(binPath).mtimeMs);
  } catch {}
  return path.join(cacheDir(), "docs", key.replace(/[^a-zA-Z0-9._+-]/g, "_") + ".txt");
}

/** Local docs for a program: man page first (no execution), else `--help`. Cached per binary version. */
export function docFor(name: string, binPath: string, notes: string[] = []): { source: "man" | "help"; text: string } | null {
  const file = cacheFile(name, binPath);
  try {
    const cached = fs.readFileSync(file, "utf8");
    if (!cached) {
      notes.push(`${name}: cached as "no docs" (${file})`);
      return null;
    }
    const nl = cached.indexOf("\n");
    return { source: cached.slice(0, nl) as "man" | "help", text: cached.slice(nl + 1) };
  } catch {}

  let found: { source: "man" | "help"; text: string } | null = null;
  let timedOut = false;
  if (which("man")) {
    const r = run("man", ["-P", "cat", name], { timeoutMs: 3000, env: { MANWIDTH: "100", LANG: "C", MAN_KEEP_FORMATTING: "" } });
    // Minimized distro images print a stub instead of the page, so require real man sections.
    if (r.ok && /^(NAME|SYNOPSIS|DESCRIPTION)\s*$/m.test(r.stdout.replace(/.\x08/g, ""))) found = { source: "man", text: r.stdout };
  }
  if (!found && !NO_EXEC.has(name) && !/^mkfs/.test(name)) {
    for (const flag of ["--help", "-h"]) {
      // First runs of big binaries can be slow (macOS verifies them), so allow 3 s.
      const r = run(binPath, [flag], { timeoutMs: 3000, env: { LANG: "C", NO_COLOR: "1" } });
      timedOut ||= r.timedOut;
      if (r.timedOut) notes.push(`${name}: ${flag} timed out after 3000 ms`);
      const text = r.stdout.length > r.stderr.length ? r.stdout : r.stderr;
      if (text.trim().length > 40) {
        found = { source: "help", text };
        break;
      }
    }
  }
  // Never cache a timeout as "no docs": the next request should try again.
  if (found || !timedOut) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, found ? `${found.source}\n${found.text}` : "");
    } catch {}
  }
  return found;
}

export interface PackageInfo {
  version: string;
  summary: string;
  bins: string[];
}

const binsFrom = (list: string) =>
  [...new Set(list.split("\n").filter((l) => /\/s?bin\/[^/]+$/.test(l.trim())).map((l) => path.basename(l.trim())))];

/** Metadata of an installed system package, or null if it isn't installed. */
export function packageInfo(name: string, pm: string): PackageInfo | null {
  const t = { timeoutMs: 800 };
  if (pm === "apt") {
    const r = run("dpkg-query", ["-W", "-f=${Status}\t${Version}\t${binary:Summary}", name], t);
    if (!r.ok || !r.stdout.includes("install ok installed")) return null;
    const [, version = "", summary = ""] = r.stdout.split("\t");
    return { version, summary, bins: binsFrom(run("dpkg", ["-L", name], t).stdout) };
  }
  if (pm === "dnf" || pm === "yum" || pm === "zypper") {
    const r = run("rpm", ["-q", "--qf", "%{VERSION}\t%{SUMMARY}", name], t);
    if (!r.ok) return null;
    const [version = "", summary = ""] = r.stdout.split("\t");
    return { version, summary, bins: binsFrom(run("rpm", ["-ql", name], t).stdout) };
  }
  if (pm === "pacman") {
    const r = run("pacman", ["-Qi", name], t);
    if (!r.ok) return null;
    const field = (k: string) => new RegExp(`^${k}\\s*:\\s*(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
    return { version: field("Version"), summary: field("Description"), bins: binsFrom(run("pacman", ["-Qlq", name], t).stdout) };
  }
  if (pm === "apk") {
    if (!run("apk", ["info", "-e", name], t).ok) return null;
    const d = run("apk", ["info", "-d", name], t).stdout.split("\n").slice(1).join(" ").trim();
    return { version: "", summary: d, bins: binsFrom(run("apk", ["info", "-L", name], t).stdout) };
  }
  return null; // brew/nix: too slow to query on every request; installed commands are still grounded via docs
}

/** `notes` (optional) collects one line per candidate explaining what happened, for --debug. */
export function ground(ask: string, profile: Profile | undefined, maxRefs = 2, notes: string[] = []): Reference[] {
  const refs: Reference[] = [];
  let lookups = 0;
  for (const cand of candidates(ask)) {
    if (refs.length >= maxRefs) break;
    const bin = which(cand);
    if (bin) {
      const t = performance.now();
      const doc = docFor(cand, bin, notes);
      if (doc) refs.push({ name: cand, source: doc.source, text: relevantExcerpt(doc.text, ask) });
      notes.push(`${cand}: ${bin} -> ${doc ? `docs from ${doc.source}` : "no docs"} (${Math.round(performance.now() - t)} ms)`);
      continue;
    }
    if (!profile?.packageManager || lookups >= 4 || !/^[a-z][a-z0-9+-]+$/.test(cand)) {
      notes.push(`${cand}: not on PATH`);
      continue;
    }
    lookups++;
    const pkg = packageInfo(cand, profile.packageManager);
    if (!pkg) {
      notes.push(`${cand}: not on PATH, not an installed ${profile.packageManager} package`);
      continue;
    }
    let text = `Installed package ${cand}${pkg.version ? ` ${pkg.version}` : ""}: ${pkg.summary}`;
    if (pkg.bins.length) text += `\nProvides commands: ${pkg.bins.slice(0, 12).join(", ")}`;
    const main = pkg.bins.includes(cand) ? cand : pkg.bins[0];
    const mainBin = main ? which(main) : null;
    if (main && mainBin) {
      const doc = docFor(main, mainBin);
      if (doc) text += `\n${relevantExcerpt(doc.text, ask, 700)}`;
    }
    refs.push({ name: cand, source: "package", text });
  }
  return refs;
}
