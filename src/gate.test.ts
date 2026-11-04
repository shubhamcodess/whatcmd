import { test } from "node:test";
import assert from "node:assert/strict";
import { check, commandWords, extractCommand, riskWarnings, splitSegments } from "./gate.js";

const exists = (w: string) => !["netstat", "ffmpegx", "Hi", "hi", "ipconfig"].includes(w);

test("extractCommand strips fences, prompts and backticks", () => {
  assert.equal(extractCommand("```bash\nls -la\n```"), "ls -la");
  assert.equal(extractCommand("$ du -sh ."), "du -sh .");
  assert.equal(extractCommand("`free -m`"), "free -m");
  assert.equal(extractCommand("Command: docker ps"), "docker ps");
});

test("splitSegments respects quotes and redirections", () => {
  assert.deepEqual(splitSegments("ps aux | grep 'a|b' && echo ok; ls 2>&1"), ["ps aux", "grep 'a|b'", "echo ok", "ls 2>&1"]);
  assert.deepEqual(splitSegments("find . -exec wc -l {} \\; | sort"), ["find . -exec wc -l {} \\;", "sort"]);
  assert.deepEqual(splitSegments("cmd &> log"), ["cmd &> log"]);
});

test("commandWords skips sudo flags, env assignments and wrappers", () => {
  assert.deepEqual(commandWords("sudo -u root lsof -i :80"), ["sudo", "lsof"]);
  assert.deepEqual(commandWords("LANG=C env FOO=1 sort x | uniq -c"), ["env", "sort", "uniq"]);
  assert.deepEqual(commandWords("find . -name '*.log' | xargs rm"), ["find", "xargs"]);
});

test("NONE and chat replies produce nothing", () => {
  assert.deepEqual(check("NONE", exists), { ok: false, reason: "not-a-shell-task" });
  assert.deepEqual(check("", exists), { ok: false, reason: "empty" });
  assert.deepEqual(check("echo Hello there", exists), { ok: false, reason: "chat-reply" });
  assert.deepEqual(check("Why don't scientists trust atoms? Because they make up everything!", exists), { ok: false, reason: "unparseable" });
});

test("echo that does real work is allowed", () => {
  const v = check("echo $PATH | tr ':' '\\n'", exists);
  assert.equal(v.ok, true);
});

test("missing programs are reported", () => {
  const v = check("netstat -tuln | grep 8080", exists);
  assert.ok(v.ok);
  assert.deepEqual(v.ok && v.missing, ["netstat"]);
});

test("risk warnings", () => {
  assert.deepEqual(riskWarnings("rm -rf /"), ["deletes your whole system or home folder"]);
  assert.deepEqual(riskWarnings("rm -rf build"), ["deletes files recursively"]);
  assert.ok(riskWarnings("curl -fsSL x.sh | sh").includes("runs a script downloaded from the internet"));
  assert.ok(riskWarnings("sudo dd if=a.iso of=/dev/sdb").includes("dd overwrites the target file or disk"));
  assert.deepEqual(riskWarnings("ls -la"), []);
  assert.deepEqual(riskWarnings("du -sh /path/to/directory"), ["contains a placeholder: edit it before running"]);
  assert.deepEqual(riskWarnings("kill -9 <pid>"), ["contains a placeholder: edit it before running"]);
  assert.deepEqual(riskWarnings("sort < input > out"), []);
});
