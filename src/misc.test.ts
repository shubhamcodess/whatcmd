import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdkit-test-"));
process.env.CMDKIT_CONFIG_DIR = path.join(tmp, "config");
process.env.CMDKIT_CACHE_DIR = path.join(tmp, "cache");
delete process.env.CMDKIT_MODEL;
delete process.env.CMDKIT_HOST;
delete process.env.OLLAMA_HOST;

const config = await import("./config.js");
const env = await import("./env.js");
const ground = await import("./ground.js");
const prompt = await import("./prompt.js");
const shell = await import("./shell.js");

test("normalizeHost handles OLLAMA_HOST forms", () => {
  assert.equal(config.normalizeHost("0.0.0.0"), "http://127.0.0.1:11434");
  assert.equal(config.normalizeHost(":9000"), "http://127.0.0.1:9000");
  assert.equal(config.normalizeHost("gpu-box:11434"), "http://gpu-box:11434");
  assert.equal(config.normalizeHost("https://ollama.example.com/"), "https://ollama.example.com");
});

test("config set / unset / env override", () => {
  config.setKey("model", "llama3.2:1b");
  config.setKey("grounding", "off");
  config.setKey("temperature", "0.2");
  let c = config.loadConfig();
  assert.equal(c.model, "llama3.2:1b");
  assert.equal(c.grounding, false);
  assert.equal(c.temperature, 0.2);
  process.env.CMDKIT_MODEL = "from-env";
  assert.equal(config.loadConfig().model, "from-env");
  delete process.env.CMDKIT_MODEL;
  config.unsetKey("model");
  c = config.loadConfig();
  assert.equal(c.model, config.DEFAULT_MODEL);
  assert.throws(() => config.setKey("nope", "1"), /Unknown key/);
  assert.throws(() => config.setKey("prefix", "has space"), /one word/);
  assert.throws(() => config.setKey("temperature", "9"), /between/);
});

test("parseOsRelease", () => {
  assert.equal(env.parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), "Ubuntu 24.04.1 LTS");
  assert.equal(env.parseOsRelease("NAME=Alpine\nVERSION_ID=3.20.0\n"), "Alpine 3.20.0");
});

test("profile prompt tells the model about the OS and tools", () => {
  const p = env.detectProfile();
  assert.ok(["linux", "macos", "windows", "other"].includes(p.os));
  const mac: typeof p = { ...p, os: "macos", distro: "macOS 14.5", userland: "bsd", installed: ["git"], missing: ["netstat"] };
  const text = env.profilePrompt(mac);
  assert.match(text, /macOS 14\.5/);
  assert.match(text, /sed -i ''/);
  assert.match(text, /Not installed \(avoid\): netstat/);
});

test("grounding candidates skip English and well-known tools", () => {
  assert.deepEqual(ground.candidates("find files larger than 100MB"), []);
  assert.deepEqual(ground.candidates("convert video.mp4 to gif with ffmpeg"), ["video.mp4", "gif", "ffmpeg"]);
  assert.deepEqual(ground.candidates("pretty print data.json using jq"), ["pretty", "data.json", "jq"]);
});

test("relevantExcerpt keeps usage and matching options", () => {
  const help = `Usage: jq [OPTIONS] FILTER [FILES...]\n\n  -c, --compact-output      compact instead of pretty-printed output;\n  -r, --raw-output          output strings without escapes and quotes;\n  -S, --sort-keys           sort keys of each object on output;\n  --tab                     use tabs for indentation;\n`;
  const ex = ground.relevantExcerpt(help, "print raw strings sorted by keys");
  assert.match(ex, /^Usage: jq/);
  assert.match(ex, /--raw-output/);
  assert.match(ex, /--sort-keys/);
  assert.doesNotMatch(ex, /--tab/);
});

test("prompt keeps system+shots stable and puts docs in the last message", () => {
  const refs = [{ name: "jq", source: "help" as const, text: "-r raw" }];
  const a = prompt.buildMessages("x", undefined, refs, "");
  const b = prompt.buildMessages("y", undefined, [], "");
  assert.deepEqual(a.slice(0, -1), b.slice(0, -1));
  assert.match(a.at(-1)!.content, /Local documentation:[\s\S]*jq[\s\S]*Request: x/);
  assert.match(prompt.systemPrompt(undefined, ""), /exactly: NONE/);
});

test("shell hooks are valid bash/zsh and use the prefix", () => {
  const bash = shell.bashHook("/cmdkit");
  const f = path.join(tmp, "h.bash");
  fs.writeFileSync(f, bash);
  assert.equal(spawnSync("bash", ["-n", f]).status, 0);
  assert.match(bash, /__cmdkit_prefix='\/cmdkit'/);
  const zsh = shell.zshHook(",ai");
  assert.match(zsh, /__cmdkit_prefix=',ai'/);
  if (spawnSync("zsh", ["--version"]).status === 0) {
    const g = path.join(tmp, "h.zsh");
    fs.writeFileSync(g, zsh);
    assert.equal(spawnSync("zsh", ["-n", g]).status, 0);
  }
});

test("installHook is idempotent and uninstall removes it", () => {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.writeFileSync(path.join(home, ".bashrc"), "alias ll='ls -l'\n");
    assert.equal(shell.installHook("bash", "/cmdkit", "linux").added, true);
    assert.equal(shell.installHook("bash", "/cmdkit", "linux").added, false);
    const rc = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    assert.equal(rc.split(">>> cmdkit >>>").length, 2);
    assert.ok(shell.uninstallHook("bash", "linux"));
    assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8").trim(), "alias ll='ls -l'");
  } finally {
    process.env.HOME = prev;
  }
});
