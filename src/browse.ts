import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cacheDir, type Config } from "./config.js";
import { stems } from "./ground.js";
import { McpStdioClient } from "./mcp.js";
import { which } from "./util.js";

/**
 * Web lookup through tiny-browse (an MCP server). Used when local docs aren't enough,
 * e.g. kubectl, whose --help lists subcommands but none of their flags.
 * Everything here fails soft: no tiny-browse, no Chrome or a timeout just means no web docs.
 */

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

/** How to start tiny-browse: config override, then the installed dependency, then PATH. */
export function resolveBrowse(cfg: Pick<Config, "webCommand">): { command: string; args: string[] } | null {
  const override = cfg.webCommand?.trim();
  if (override) {
    return /\.(c|m)?js$/.test(override) ? { command: process.execPath, args: [override] } : { command: override, args: [] };
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("tiny-browse/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["tiny-browse"];
    if (bin) {
      const file = path.resolve(path.dirname(pkgPath), bin);
      if (fs.existsSync(file)) return { command: process.execPath, args: [file] };
    }
  } catch {}
  const onPath = which("tiny-browse");
  return onPath ? { command: onPath, args: [] } : null;
}

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

/**
 * Look up how to do `ask` on the web. Returns null (with a note) on any failure.
 * `notes` collects one line per step for --debug.
 */
export async function lookup(ask: string, cfg: Config, o: LookupOptions = {}, notes: string[] = []): Promise<WebDoc | null> {
  const tool = o.tool;
  const query = cleanQuery(o.query ?? `${tool && !ask.toLowerCase().includes(tool) ? tool + " " : ""}${ask} command`);
  if (!query) return null;
  const ref = tool ? REFERENCE[tool] : undefined;
  const t = performance.now();
  let client: McpStdioClient | null = null;
  const deadline = Date.now() + cfg.webTimeoutMs;
  const left = () => Math.max(500, deadline - Date.now());
  /** Start tiny-browse on first use; cached answers never start it. */
  const connect = async () => {
    if (client) return client;
    const how = resolveBrowse(cfg);
    if (!how) throw new Error("tiny-browse not found (install it, or set webCommand)");
    client = new McpStdioClient(how.command, how.args, { TINY_BROWSE_LOG_LEVEL: "error" });
    await client.start(Math.min(5000, left()));
    return client;
  };
  try {
    // 1. A known reference page: cache the whole page per URL, pick lines per request locally.
    if (ref) {
      let page = readCache(`page\n${ref}`)?.text;
      if (page) notes.push(`web: ${ref} (cached)`);
      else {
        const r = await (await connect()).callTool("web_fetch", { urls: [ref], max_tokens: 30000 }, left());
        page = r.isError ? "" : r.text;
        notes.push(`web: read ${ref} -> ${r.isError ? `error: ${r.text.slice(0, 120)}` : `${page.length} chars`}`);
        if (page) writeCache(`page\n${ref}`, { text: page, source: ref, cached: false });
      }
      const text = page ? webExcerpt(page, ask, tool) : "";
      if (text) return { text, source: ref, cached: notes.at(-1)!.endsWith("(cached)") };
      if (page) notes.push(`web: nothing in ${ref} matches the request`);
    }

    // 2. A search, cached per query.
    const key = `search\n${query}`;
    const hit = readCache(key);
    if (hit) {
      notes.push(`web: search "${query}" (cached${hit.text ? "" : ", nothing found"})`);
      return hit.text ? hit : null;
    }
    const r = await (await connect()).callTool("web_search", { query, read: 2, max_tokens: 3000 }, left());
    const text = r.isError ? "" : webExcerpt(r.text, ask, tool);
    notes.push(`web: search "${query}" -> ${r.isError ? "error" : text ? `${text.split("\n").length} lines` : "nothing relevant"}`);
    const doc = text ? { text, source: firstSource(r.text) || "web search", cached: false } : null;
    // "Nothing found" from a blocked or degraded search is kept for an hour only, not a week.
    const degraded = r.isError || /CAPTCHA|may not match|unavailable/i.test(r.text.slice(0, 600));
    writeCache(key, doc ?? { text: "", source: "", cached: false }, !doc && degraded);
    return doc;
  } catch (e) {
    notes.push(`web: ${(e as Error).message}`);
    return null;
  } finally {
    notes.push(`web: ${Math.round(performance.now() - t)} ms`);
    await (client as McpStdioClient | null)?.close();
  }
}

/** For `whatcmd doctor`: can tiny-browse be found and started? */
export async function checkBrowse(cfg: Config): Promise<{ ok: boolean; detail: string }> {
  const how = resolveBrowse(cfg);
  if (!how) return { ok: false, detail: "tiny-browse not found: npm install -g tiny-browse, or set webCommand" };
  const where = [how.command, ...how.args].join(" ");
  const client = new McpStdioClient(how.command, how.args, { TINY_BROWSE_LOG_LEVEL: "error" });
  try {
    await client.start(5000);
    return { ok: true, detail: where };
  } catch (e) {
    return { ok: false, detail: `${where}: ${(e as Error).message}` };
  } finally {
    await client.close();
  }
}
