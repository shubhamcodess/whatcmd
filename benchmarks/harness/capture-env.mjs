import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const H = os.homedir();
const sh = (c, env = {}) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } }).trim(); } catch { return null; } };
const has = (t) => sh(`command -v ${t}`) !== null;
const sandboxCfg = path.join(H, "cmdkit-bench/sandbox/config-env");
fs.mkdirSync(sandboxCfg, { recursive: true });
const env = {
  os: sh("sw_vers -productName") + " " + sh("sw_vers -productVersion") + " (build " + sh("sw_vers -buildVersion") + ")",
  cpu: sh("sysctl -n machdep.cpu.brand_string"),
  cores: Number(sh("sysctl -n hw.ncpu")),
  performance_cores: Number(sh("sysctl -n hw.perflevel0.physicalcpu")),
  ram_gb: Math.round(os.totalmem() / 1024 ** 3),
  gpu: sh("system_profiler SPDisplaysDataType | grep -E 'Chipset Model' | sed 's/^ *//'"),
  node: process.version,
  ollama: sh("ollama --version 2>/dev/null | tail -1") ,
  ollama_server: sh("curl -s http://127.0.0.1:11434/api/version"),
  bash: sh("bash --version | head -1"),
  bash_path_versions: sh("ls -1 /bin/bash /usr/bin/bash /opt/homebrew/bin/bash /usr/local/bin/bash 2>/dev/null"),
  zsh: sh("zsh --version"),
  repo_commit: sh("git -C ~/cmdkit-bench/repo rev-parse HEAD"),
  repo_branch: sh("git -C ~/cmdkit-bench/repo rev-parse --abbrev-ref HEAD"),
  npm_test_summary: sh("cd ~/cmdkit-bench/repo && npm test 2>&1 | grep -E '^# (pass|fail|tests)'"),
  profile: sh(`node ${H}/cmdkit-bench/repo/dist/cli.js profile 2>/dev/null`, { WHATCMD_CONFIG_DIR: sandboxCfg, WHATCMD_CACHE_DIR: path.join(H, "cmdkit-bench/sandbox/cache-env") }),
  captured_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(H, "cmdkit-bench/results/environment.json"), JSON.stringify(env, null, 2) + "\n");
const installed = [], notInstalled = [];
for (const t of "jq rg fd fzf ffmpeg lsof fuser docker podman kubectl htop tree rsync nmap tmux sqlite3 python3 node npm make gcc openssl gpg ssh-keygen tcpdump strace systemctl journalctl pandoc gh helm dig nc netstat aws terraform ansible".split(" "))
  (has(t) ? installed : notInstalled).push(t);
const WELL_KNOWN = "ls cd cp mv rm mkdir rmdir find grep sed awk cat head tail sort uniq wc cut tr xargs tar gzip gunzip zip unzip chmod chown ln touch echo printf ps kill pkill killall top free df du date ssh scp curl wget git ping which whoami id env export less more diff stat mount umount sudo apt apt-get yum dnf brew pacman man history clear sh bash zsh".split(" ");
const groundable = installed.filter((t) => !WELL_KNOWN.includes(t));
const notInst = ["kubectl","terraform","helm","ansible","nmap","htop","tmux","pandoc","gh","aws","fd","fzf","tree","strace","systemctl","journalctl"].filter((t) => !has(t));
fs.writeFileSync(path.join(H, "cmdkit-bench/results/tools.json"), JSON.stringify({
  os_family: "macos", package_manager: sh("command -v brew") ? "brew" : null,
  installed_groundable: groundable.filter((t) => has(t)),
  not_installed: notInst,
  package_examples: [],
  package_examples_note: "not applicable: brew system; whatcmd does not query brew packages (ground.ts packageInfo returns null for brew)",
  well_known_skipped_by_grounding: WELL_KNOWN,
  fake_tools: ["zorbctl", "qlipper", "mendaro"],
}, null, 2) + "\n");
console.log("groundable:", groundable.filter((t) => has(t)).join(" "));
console.log("not_installed:", notInst.join(" "));
