import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WHATCMD_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "whatcmd-refine-"));
const s = await import("./session.js");
const { refinePrompt, REFINE_SHOTS } = await import("./prompt.js");
const shell = await import("./shell.js");

test("sessions are per terminal and expire", () => {
  const now = 1_000_000;
  s.saveSession("111", { ask: "find big files", command: "find . -size +100M", turns: 0 }, now);
  assert.equal(s.loadSession("111", now + 1000)?.command, "find . -size +100M");
  assert.equal(s.loadSession("222", now + 1000), null, "another tab sees nothing");
  assert.equal(s.loadSession("111", now + s.SESSION_TTL_MS + 1), null, "expired after 15 minutes");
  s.clearSession("111");
  assert.equal(s.loadSession("111", now), null);
});

test("refine base: the user's run/edited command when it matches, else the generated one", () => {
  const gen = "find . -size +100M";
  assert.deepEqual(s.refineBase(gen), { command: gen });
  assert.deepEqual(s.refineBase(gen, gen, 0), { command: gen, status: 0 });
  assert.deepEqual(s.refineBase(gen, "find ~/Downloads -size +100M", 1), { command: "find ~/Downloads -size +100M", status: 1 });
  assert.deepEqual(s.refineBase(gen, "ls -la", 0), { command: gen }, "unrelated last command is ignored");
  assert.deepEqual(s.refineBase("tar xzf a.tgz", "sudo tar xzf a.tgz", 2), { command: "sudo tar xzf a.tgz", status: 2 });
  // "ls" was run before "ls -a" was generated; nothing new ran since, so refine "ls -a" (bug found in shell test)
  assert.deepEqual(s.refineBase("ls -a", "ls", 0, "ls"), { command: "ls -a" });
  assert.deepEqual(s.refineBase("ls -a", "ls -a -R", 0, "ls"), { command: "ls -a -R", status: 0 });
});

test("refine prompt carries the base, the original request, the change and the exit status", () => {
  const p = refinePrompt("find . -size +100M", "find big files", "only pdfs");
  assert.match(p, /^Current command: find \. -size \+100M\nIt was made for: find big files\nChange: only pdfs\n/);
  assert.match(refinePrompt("x", "y", "fix that", 2), /failed with exit status 2/);
  assert.match(refinePrompt("x", "y", "sort it", 0), /succeeded/);
  assert.equal(REFINE_SHOTS.length, 3);
});

test("limit is 5", () => {
  assert.equal(s.MAX_REFINES, 5);
});

test("hooks handle the + prefix and pass session, status and last command", () => {
  const b = shell.bashHook("/w");
  assert.match(b, /"\$__whatcmd_prefix\+ "\*/);
  assert.match(b, /extra=\(--refine\)/);
  assert.match(b, /extra\+=\("--last-status=\$st" "--last-cmd=\$last"\)/);
  assert.match(b, /"--session=\$\$"/);
  const z = shell.zshHook("/w");
  assert.match(z, /"\$__whatcmd_prefix\+ "\*/);
  assert.match(z, /fc -ln -1/);
  // $? must be captured before anything else runs
  assert.match(b, /__whatcmd_hook\(\) \{\n  local st=\$\?/);
  assert.match(z, /__whatcmd_accept_line\(\) \{\n  local st=\$\?/);
});
