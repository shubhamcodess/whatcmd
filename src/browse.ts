import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheDir, type Config } from "./config.js";
import { stems } from "./ground.js";

/**
 * Web lookup through tiny-browse (used as a library). Only runs after the model failed on a
 * request, e.g. kubectl, whose --help lists subcommands but none of their flags.
 * Everything here fails soft: no Chrome, a block or a timeout just means no web docs.
 *
 * Rate limits: tiny-browse keeps per-engine budgets shared by every tiny-browse process on the
 * machine (and pauses an engine after a CAPTCHA). whatcmd never passes its own tiny-browse
 * config, so the user's tiny-browse settings and budgets apply, and on top of that it makes at
 * most one page read and one search per request, never retries a blocked search, and pauses
 * its own searches for a while when every engine refused.
 */

type TinyBrowse = Pick<typeof import("@shubhamcodess/tiny-browse"), "webFetch" | "webSearch" | "doctor">;

let load: () => Promise<TinyBrowse> = () => import("@shubhamcodess/tiny-browse");

/** Tests: replace tiny-browse with a fake. */
export function setTinyBrowse(fake: TinyBrowse | null): void {
  load = fake ? async () => fake : () => import("@shubhamcodess/tiny-browse");
}

const errCode = (e: unknown): string => ((e as { code?: unknown })?.code as string | undefined) ?? "error";

export interface WebDoc {
  /** Short excerpt of relevant command lines, ready for the prompt. */
  text: string;
  /** Page the excerpt came from. */
  source: string;
  cached: boolean;
}

/**
 * Official reference pages for big CLIs whose local --help is too shallow. Reading one of these
 * with `focus` is faster and more reliable than a search engine, which often blocks automated browsers.
 */
export const REFERENCE: Record<string, string> = {
  // Each checked to hold real example command lines (not just an index of subcommands).
  kubectl: "https://kubernetes.io/docs/reference/kubectl/quick-reference/",
  helm: "https://helm.sh/docs/intro/cheatsheet/",
  gcloud: "https://cloud.google.com/sdk/docs/cheatsheet",
  az: "https://learn.microsoft.com/en-us/cli/azure/reference-index",
  gh: "https://cli.github.com/manual/examples",
  kind: "https://kind.sigs.k8s.io/docs/user/quick-start/",
  kustomize: "https://kubectl.docs.kubernetes.io/guides/introduction/kustomize/",
  istioctl: "https://istio.io/latest/docs/reference/commands/istioctl/",
  argocd: "https://argo-cd.readthedocs.io/en/stable/getting_started/",
  eksctl: "https://eksctl.io/getting-started/",
};

/**
 * Pick the lines of a web page that look like commands for `tool` and match the request:
 * lines inside code blocks first, then inline `code` spans. Keeps trailing # comments, which
 * on cheat sheets explain what each line does.
 */
export function webExcerpt(markdown: string, ask: string, tool: string | undefined, maxChars = 1000): string {
  const want = stems(ask);
  const lines: { i: number; text: string; score: number }[] = [];
  let inCode = false;
  const raw = markdown.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    const candidates = inCode ? [l.trim()] : [...l.matchAll(/`([^`]{4,200})`/g)].map((m) => m[1].trim());
    for (let text of candidates) {
      text = text.replace(/^\$\s+/, "").replace(/\s{2,}#/, "  #");
      if (!text || text.length > 220 || text.startsWith("#")) continue;
      if (tool && !new RegExp(`(^|[\\s|;(])${tool.replace(/[.+]/g, "\\$&")}\\b`).test(text)) continue;
      const score = [...stems(text)].filter((s) => want.has(s)).length;
      if (score > 0) lines.push({ i, text, score });
    }
  }
  const seen = new Set<string>();
  const picked = lines
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true)))
    .slice(0, 10)
    .sort((a, b) => a.i - b.i);
  let out = "";
  for (const p of picked) {
    if (out.length + p.text.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + p.text;
  }
  return out;
}

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function cachePath(key: string): string {
  const h = crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
  return path.join(cacheDir(), "web", `v1-${h}.json`);
}

/** A blocked or degraded search is remembered briefly, so it doesn't cost every request a second. */
const DEGRADED_TTL_MS = 3600 * 1000;

function readCache(key: string): WebDoc | null {
  try {
    const file = cachePath(key);
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { text: string; source: string; degraded?: boolean };
    if (Date.now() - fs.statSync(file).mtimeMs > (j.degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS)) return null;
    return { text: j.text, source: j.source, cached: true };
  } catch {
    return null;
  }
}

function writeCache(key: string, doc: WebDoc, degraded = false): void {
  try {
    const file = cachePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ text: doc.text, source: doc.source, ...(degraded ? { degraded } : {}) }));
  } catch {}
}

/** First URL in a tiny-browse answer's page header ("> https://… · Site"). */
function firstSource(markdown: string): string {
  return /^>\s*(https?:\/\/\S+)/m.exec(markdown)?.[1] ?? /\]\((https?:\/\/[^)\s]+)\)/.exec(markdown)?.[1] ?? "";
}

/** Keep queries to a tool name and plain words: nothing path-like or secret-looking leaves the machine. */
export function cleanQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter((w) => w && !/[\/\\~=@:]|^\$|^-|\d{4,}/.test(w))
    .join(" ")
    .slice(0, 120)
    .trim();
}

export interface LookupOptions {
  /** Program the request is about (kubectl, helm …), if known. */
  tool?: string;
  /** Search query; defaults to tool + request. */
  query?: string;
}

/** After every search engine refused, whatcmd stops searching for this long (tiny-browse's first CAPTCHA pause). */
export const SEARCH_PAUSE_MS = 15 * 60 * 1000;
const pauseFile = () => path.join(cacheDir(), "web", "search-paused.json");

/** Minutes left on whatcmd's own search pause, or 0. */
export function searchPausedFor(now = Date.now()): number {
  try {
    const until = (JSON.parse(fs.readFileSync(pauseFile(), "utf8")) as { until: number }).until;
    return until > now ? Math.ceil((until - now) / 60_000) : 0;
  } catch {
    return 0;
  }
}

function pauseSearch(now = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(pauseFile()), { recursive: true });
    fs.writeFileSync(pauseFile(), JSON.stringify({ until: now + SEARCH_PAUSE_MS }));
  } catch {}
}

/** Every engine was skipped or refused (budget used up, paused after a CAPTCHA, blocked). */
const allRefused = (attempts: { status: string }[]) =>
  attempts.length > 0 && attempts.every((a) => !["ok", "no_results", "off_topic"].includes(a.status));

/**
 * Look up how to do `ask` on the web. Returns null (with a note) on any failure.
 * `notes` collects one line per step for --debug; a line starting "web: paused" means
 * searches are rate-limited right now.
 */
export async function lookup(ask: string, cfg: Config, o: LookupOptions = {}, notes: string[] = []): Promise<WebDoc | null> {
  const tool = o.tool;
  const query = cleanQuery(o.query ?? `${tool && !ask.toLowerCase().includes(tool) ? tool + " " : ""}${ask} command`);
  if (!query) return null;
  const ref = tool ? REFERENCE[tool] : undefined;
  const t = performance.now();
  const deadline = Date.now() + cfg.webTimeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  try {
    // 1. A known reference page: plain HTTP (no Chrome, no search budget). The whole page is
    //    cached per URL for a week; lines are picked per request locally.
    if (ref) {
      let page = readCache(`page\n${ref}`)?.text;
      const cached = page !== undefined;
      if (cached) notes.push(`web: ${ref} (cached)`);
      else {
        try {
          const tb = await load();
          const r = await tb.webFetch({ urls: [ref], max_tokens: 30000 }, { mode: "http", timeoutMs: left() });
          page = r.pages[0]?.markdown ?? "";
          notes.push(`web: read ${ref} -> ${page.length} chars`);
          if (page) writeCache(`page\n${ref}`, { text: page, source: ref, cached: false });
        } catch (e) {
          notes.push(`web: read ${ref} -> ${errCode(e)}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      const text = page ? webExcerpt(page, ask, tool) : "";
      if (text) return { text, source: ref, cached };
      if (page) notes.push(`web: nothing in ${ref} matches the request`);
    }

    // 2. A search, cached per query.
    const key = `search\n${query}`;
    const hit = readCache(key);
    if (hit) {
      notes.push(`web: search "${query}" (cached${hit.text ? "" : ", nothing found"})`);
      return hit.text ? hit : null;
    }
    const paused = searchPausedFor();
    if (paused) {
      notes.push(`web: paused, search engines are rate-limited (${paused} min left)`);
      return null;
    }
    const tb = await load();
    let r;
    try {
      r = await tb.webSearch({ query, read: 2, max_tokens: 3000 }, { timeoutMs: left(), useServer: "auto" });
    } catch (e) {
      // Never retried: a blocked search means the engines' budgets are used up or they want a CAPTCHA.
      if (errCode(e) === "blocked") {
        pauseSearch();
        notes.push(`web: paused, search engines are rate-limited (${Math.round(SEARCH_PAUSE_MS / 60_000)} min)`);
      } else notes.push(`web: search "${query}" -> ${errCode(e)}: ${(e as Error).message.slice(0, 120)}`);
      return null;
    }
    const attempts = r.attempts.map((a) => `${a.provider} ${a.status}`).join(", ");
    if (!r.results.length && allRefused(r.attempts)) {
      pauseSearch();
      notes.push(`web: paused, search engines are rate-limited (${attempts})`);
      return null;
    }
    const text = webExcerpt(r.markdown, ask, tool);
    notes.push(
      `web: search "${query}" via ${r.provider}${r.cached ? " (cached by tiny-browse)" : ""} [${attempts}] -> ${text ? `${text.split("\n").length} lines` : "nothing relevant"}`,
    );
    const doc = text ? { text, source: r.pages[0]?.finalUrl || r.results[0]?.url || firstSource(r.markdown) || "web search", cached: r.cached } : null;
    // "Nothing found" from a degraded engine is kept for an hour only, not a week.
    writeCache(key, doc ?? { text: "", source: "", cached: false }, !doc && Boolean(r.warning));
    return doc;
  } catch (e) {
    notes.push(`web: ${errCode(e)}: ${(e as Error).message}`);
    return null;
  } finally {
    notes.push(`web: ${Math.round(performance.now() - t)} ms`);
  }
}

/** For `whatcmd doctor`: tiny-browse's own checks (browser, engine budgets), without starting Chrome. */
export async function checkBrowse(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  try {
    const tb = await load();
    const checks = await tb.doctor({ startChrome: false });
    const paused = searchPausedFor();
    return paused ? [...checks, { name: "whatcmd search pause", ok: false, detail: `${paused} min left (every engine refused)` }] : checks;
  } catch (e) {
    return [{ name: "tiny-browse", ok: false, detail: (e as Error).message }];
  }
}
