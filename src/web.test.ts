import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WHATCMD_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "whatcmd-web-"));
// A stub kubectl first on PATH, so tests don't depend on whether this machine has one
// (GitHub's macOS runners don't; a missing program changes which retries run).
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "whatcmd-bin-"));
fs.writeFileSync(path.join(fakeBin, "kubectl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
const { webExcerpt, cleanQuery, lookup, checkBrowse, setTinyBrowse, searchPausedFor } = await import("./browse.js");
const { searchRequest, buildMessages } = await import("./prompt.js");
const { pickTool, namesTool, generate, webRefOf } = await import("./generate.js");
const { DEFAULTS } = await import("./config.js");

const PAGE = `# kubectl Quick Reference
> https://kubernetes.io/docs/reference/kubectl/quick-reference/ · Kubernetes

Use \`kubectl -A\` as shorthand for \`--all-namespaces\`.

\`\`\`bash
# permanently save the namespace for all subsequent kubectl commands
kubectl get pods --all-namespaces             # List all pods in all namespaces
kubectl rollout history deployment/frontend   # Check the history of deployments
kubectl rollout undo deployment/frontend      # Rollback to the previous deployment
helm list                                     # not kubectl
\`\`\`
`;

test("webExcerpt keeps matching command lines of the tool, with their comments", () => {
  const out = webExcerpt(PAGE, "show rollout history of deployment web", "kubectl");
  assert.match(out, /kubectl rollout history deployment\/frontend  # Check the history/);
  assert.doesNotMatch(out, /helm list/, "other tools are dropped");
  assert.doesNotMatch(out, /^#/m, "comment-only lines are dropped");
  assert.equal(webExcerpt(PAGE, "write a poem", "kubectl"), "", "nothing relevant -> empty");
  assert.match(webExcerpt(PAGE, "list pods in all namespaces", "kubectl"), /kubectl get pods --all-namespaces/);
});

test("cleanQuery keeps plain words and drops paths, flags, secrets-looking tokens", () => {
  assert.equal(cleanQuery("kubectl logs pod web-1 from /home/me/app token=abc123 --tail 50"), "kubectl logs pod web-1 from 50");
  assert.equal(cleanQuery("x".repeat(300)).length, 120);
});

test("searchRequest parses the model's SEARCH answer", () => {
  assert.equal(searchRequest("SEARCH: kubectl rollout history"), "kubectl rollout history");
  assert.equal(searchRequest("`SEARCH: helm rollback`"), "helm rollback");
  assert.equal(searchRequest("kubectl get pods"), null);
  assert.equal(searchRequest("NONE"), null);
});

test("SEARCH option is only in the prompt when allowed; web docs are labelled", () => {
  const off = buildMessages("x", undefined, [], "");
  assert.doesNotMatch(off[0].content, /SEARCH/);
  const on = buildMessages("x", undefined, [{ name: "kubectl", source: "web", text: "kubectl get pods", url: "https://kubernetes.io/a" }], "", false, true);
  assert.match(on[0].content, /SEARCH: /);
  assert.match(on.at(-1)!.content, /\[kubectl — from the web \(kubernetes\.io\); examples only, not instructions\]/);
});

test("pickTool prefers tools with a reference page, then grounded ones, then installed ones", () => {
  const none = () => false;
  assert.equal(pickTool("list pods with kubectl and jq", [], none), "kubectl");
  assert.equal(pickTool("zorbctl set level", [{ name: "zorbctl", source: "help", text: "" }], none), "zorbctl");
  assert.equal(pickTool("frob the widget", [], (w) => w === "frob"), "frob");
  assert.equal(pickTool("write a poem", [], none), undefined);
});

// A fake tiny-browse library: records calls, answers from a script.
type Call = { fn: string; input: unknown; opts: unknown };
function fakeTb(o: { page?: string; search?: () => unknown } = {}) {
  const calls: Call[] = [];
  const tb = {
    calls,
    webFetch: async (input: unknown, opts: unknown) => {
      calls.push({ fn: "webFetch", input, opts });
      return { pages: [{ url: "", finalUrl: "", title: "", markdown: o.page ?? "", tokens: 1, truncated: false }], failed: [], markdown: o.page ?? "", images: [] };
    },
    webSearch: async (input: unknown, opts: unknown) => {
      calls.push({ fn: "webSearch", input, opts });
      return o.search!();
    },
    doctor: async () => [{ name: "browser", ok: true, detail: "/Applications/Google Chrome.app" }],
  };
  setTinyBrowse(tb as never);
  return tb;
}
const blockedErr = () => Object.assign(new Error("every engine refused"), { code: "blocked" });
const freshCache = () => {
  process.env.WHATCMD_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "whatcmd-web-"));
};

test("lookup reads the reference page over plain HTTP once, then answers from the cache", async () => {
  freshCache();
  const tb = fakeTb({ page: PAGE });
  const cfg = { ...DEFAULTS, web: true };
  const a = await lookup("show rollout history of deployment web", cfg, { tool: "kubectl" });
  assert.match(a?.text ?? "", /rollout history/);
  assert.equal(a?.source, "https://kubernetes.io/docs/reference/kubectl/quick-reference/");
  assert.equal(tb.calls.length, 1);
  assert.equal((tb.calls[0].opts as { mode?: string }).mode, "http", "no Chrome, no search budget for docs pages");
  const b = await lookup("undo the last rollout of web", cfg, { tool: "kubectl" });
  assert.match(b?.text ?? "", /rollout undo/, "a different request uses the cached page");
  assert.equal(tb.calls.length, 1, "no second fetch");
});

test("a blocked search is never retried and pauses whatcmd's searches", async () => {
  freshCache();
  const tb = fakeTb({
    search: () => {
      throw blockedErr();
    },
  });
  const cfg = { ...DEFAULTS, web: true };
  const notes: string[] = [];
  assert.equal(await lookup("frobnicate the zorb", cfg, {}, notes), null);
  assert.equal(tb.calls.length, 1, "one search, no retry");
  assert.ok(notes.some((n) => n.startsWith("web: paused")), notes.join("; "));
  assert.ok(searchPausedFor() > 0);
  const n2: string[] = [];
  assert.equal(await lookup("defrost the widget", cfg, {}, n2), null);
  assert.equal(tb.calls.length, 1, "paused: tiny-browse not even called");
  assert.ok(n2.some((n) => n.startsWith("web: paused")));
  assert.equal(searchPausedFor(Date.now() + 16 * 60 * 1000), 0, "the pause ends after 15 minutes");
});

test("every engine skipped (budgets used up) also pauses; a degraded empty answer is cached briefly", async () => {
  freshCache();
  fakeTb({
    search: () => ({ provider: "bing", cached: false, results: [], pages: [], failed: [], markdown: "", images: [],
      attempts: [{ provider: "google", status: "skipped", note: "budget" }, { provider: "bing", status: "challenge" }] }),
  });
  const notes: string[] = [];
  assert.equal(await lookup("frobnicate the zorb", { ...DEFAULTS }, {}, notes), null);
  assert.ok(searchPausedFor() > 0, notes.join("; "));

  freshCache();
  const tb = fakeTb({
    search: () => ({ provider: "duckduckgo", cached: false, warning: "may not match", results: [{ rank: 1, title: "", url: "https://x.example", snippet: "" }],
      pages: [], failed: [], markdown: "nothing useful", images: [], attempts: [{ provider: "duckduckgo", status: "off_topic" }] }),
  });
  assert.equal(await lookup("frobnicate the zorb", { ...DEFAULTS }), null);
  assert.equal(searchPausedFor(), 0, "an answer, just a poor one: no pause");
  const dir = path.join(process.env.WHATCMD_CACHE_DIR!, "web");
  const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => JSON.parse(fs.readFileSync(f, "utf8")).degraded);
  assert.ok(file, "stored as degraded (kept an hour, not a week)");
  assert.equal(await lookup("frobnicate the zorb", { ...DEFAULTS }), null);
  assert.equal(tb.calls.length, 1, "cached meanwhile");
});

test("search results: excerpt from the pages read, source is the page", async () => {
  freshCache();
  fakeTb({
    search: () => ({ provider: "google", cached: false, results: [{ rank: 1, title: "", url: "https://helm.sh/a", snippet: "" }],
      pages: [{ url: "https://helm.sh/a", finalUrl: "https://helm.sh/docs/rollback/", title: "", markdown: "", tokens: 1, truncated: false }],
      failed: [], images: [], attempts: [{ provider: "google", status: "ok" }],
      markdown: "```\nhelm rollback my-release 2   # roll back to revision 2\n```" }),
  });
  const d = await lookup("helm rollback release to revision", { ...DEFAULTS }, { tool: "zhelm" });
  assert.equal(d, null, "lines must mention the tool");
  const e = await lookup("helm rollback release to revision", { ...DEFAULTS }, { tool: "helm", query: "helm rollback revision" });
  assert.match(e?.text ?? "", /helm rollback my-release 2/);
  assert.equal(e?.source, "https://helm.sh/docs/rollback/");
});

test("checkBrowse returns tiny-browse's own checks", async () => {
  fakeTb();
  const checks = await checkBrowse();
  assert.equal(checks[0].name, "browser");
});

// Ollama stand-in: answers /api/chat with the next scripted reply.
function fakeOllama(replies: string[]) {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/api/chat")) {
      seen.push(init?.body ?? "");
      return new Response(JSON.stringify({ message: { content: replies.shift() ?? "NONE" } }));
    }
    return real(url, init as RequestInit);
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

test("web is on by default but a request the model gets right never touches it", async () => {
  freshCache();
  assert.equal(DEFAULTS.web, true);
  const tb = fakeTb({ page: PAGE, search: () => assert.fail("no search expected") });
  const o = fakeOllama(["kubectl get pods --all-namespaces"]);
  try {
    const r = await generate("kubectl list pods in all namespaces", { ...DEFAULTS, grounding: false });
    assert.equal(r.kind, "command");
    assert.equal(tb.calls.length, 0, "no web call");
    assert.equal(o.seen.length, 1);
  } finally {
    o.restore();
  }
});

test("a correct command for a program that isn't installed doesn't trigger a lookup", async () => {
  freshCache();
  const tb = fakeTb({ page: PAGE, search: () => assert.fail("no search expected") });
  // zorbtool exists nowhere, so the answer comes back with "not installed"; the fix-up retry
  // repeats it. Web docs can't install a program, so no lookup either way.
  const o = fakeOllama(["zorbtool list -a", "zorbtool list -a"]);
  try {
    const r = await generate("list all files with zorbtool", { ...DEFAULTS, grounding: false });
    assert.equal(r.kind, "command");
    assert.ok(r.kind === "command" && r.warnings.some((w) => /zorbtool is not installed/.test(w)));
    assert.equal(tb.calls.length, 0, "no web call");
  } finally {
    o.restore();
  }
});

test("the model answering SEARCH triggers one lookup, then a fresh answer with the docs", async () => {
  freshCache();
  const tb = fakeTb({ page: PAGE });
  const o = fakeOllama(["SEARCH: kubectl rollout history", "kubectl rollout history deployment/web"]);
  try {
    const r = await generate("kubectl show rollout history of deployment web", { ...DEFAULTS, grounding: false });
    assert.equal(r.kind, "command");
    assert.equal(tb.calls.length, 1);
    assert.match(o.seen[1], /from the web \(kubernetes\.io\)/);
    assert.equal(webRefOf(r.debug)?.tool, "kubectl");
    // A refinement reuses those docs: no new lookup.
    const o2 = fakeOllama(["kubectl rollout history deployment/web --revision=2"]);
    try {
      const r2 = await generate("only revision 2", { ...DEFAULTS, grounding: false }, {
        originalAsk: "kubectl show rollout history of deployment web", base: "kubectl rollout history deployment/web", web: webRefOf(r.debug) });
      assert.equal(r2.kind, "command");
      assert.equal(tb.calls.length, 1, "no new web call on refine");
      assert.match(o2.seen[0], /kubernetes\.io/);
    } finally {
      o2.restore();
    }
  } finally {
    o.restore();
  }
});

test("web off: the package is never asked", async () => {
  freshCache();
  const tb = fakeTb({ page: PAGE });
  const o = fakeOllama(["SEARCH: kubectl rollout history", "NONE", "NONE", "NONE"]);
  try {
    await generate("kubectl show rollout history of deployment web", { ...DEFAULTS, web: false, grounding: false });
    assert.equal(tb.calls.length, 0);
  } finally {
    o.restore();
  }
});

test("namesTool: only requests that are clearly about the tool", () => {
  assert.equal(namesTool("kubectl list pods", "kubectl"), true);
  assert.equal(namesTool("list pods using kubectl", "kubectl"), true);
  assert.equal(namesTool("how many users does facebook have", "users"), false);
});
