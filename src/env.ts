import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "./util.js";

export interface Profile {
  os: "linux" | "macos" | "windows" | "other";
  /** e.g. "Ubuntu 24.04.1 LTS" or "macOS 14.5" */
  distro: string;
  wsl: boolean;
  arch: string;
  shell: string;
  packageManager: string | null;
  userland: "gnu" | "bsd" | "busybox" | "unknown";
  /** Notable tools that are installed / missing, so the model picks commands that exist. */
  installed: string[];
  missing: string[];
  detectedAt: string;
}

/** Tools the model often reaches for; knowing which exist avoids "command not found". */
export const NOTABLE_TOOLS = [
  "ss", "netstat", "lsof", "fuser", "ip", "ifconfig", "curl", "wget", "dig", "nc",
  "rg", "fd", "fzf", "jq", "tree", "rsync", "zip", "unzip", "7z",
  "git", "docker", "podman", "kubectl", "systemctl", "journalctl",
  "python3", "node", "ffmpeg", "magick", "htop",
];

const PACKAGE_MANAGERS: [bin: string, name: string][] = [
  ["brew", "brew"], ["apt-get", "apt"], ["dnf", "dnf"], ["yum", "yum"], ["pacman", "pacman"],
  ["zypper", "zypper"], ["apk", "apk"], ["nix-env", "nix"],
];

export function parseOsRelease(text: string): string {
  const get = (k: string) => {
    const m = new RegExp(`^${k}=(?:"([^"]*)"|(.*))$`, "m").exec(text);
    return m ? (m[1] ?? m[2] ?? "").trim() : "";
  };
  return get("PRETTY_NAME") || [get("NAME"), get("VERSION_ID")].filter(Boolean).join(" ");
}

export function detectProfile(): Profile {
  const plat = process.platform;
  const osName: Profile["os"] =
    plat === "linux" ? "linux" : plat === "darwin" ? "macos" : plat === "win32" ? "windows" : "other";

  let distro = "";
  let wsl = false;
  if (osName === "linux") {
    try {
      distro = parseOsRelease(fs.readFileSync("/etc/os-release", "utf8"));
    } catch {}
    try {
      wsl = /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
    } catch {}
  } else if (osName === "macos") {
    const r = run("sw_vers", ["-productVersion"], { timeoutMs: 1000 });
    distro = r.ok ? `macOS ${r.stdout.trim()}` : "macOS";
  }

  let userland: Profile["userland"] = "unknown";
  if (osName === "macos") userland = "bsd";
  else if (osName === "linux") {
    const ls = which("ls");
    let real = "";
    try {
      real = ls ? fs.realpathSync(ls) : "";
    } catch {}
    if (/busybox/.test(real)) userland = "busybox";
    else if (/GNU/.test(run("ls", ["--version"], { timeoutMs: 1000 }).stdout)) userland = "gnu";
  }

  const packageManager = PACKAGE_MANAGERS.find(([bin]) => which(bin))?.[1] ?? null;
  const installed = NOTABLE_TOOLS.filter((t) => which(t));
  const missing = NOTABLE_TOOLS.filter((t) => !installed.includes(t));

  return {
    os: osName,
    distro,
    wsl,
    arch: os.arch(),
    shell: path.basename(process.env.SHELL || "") || "sh",
    packageManager,
    userland,
    installed,
    missing,
    detectedAt: new Date().toISOString(),
  };
}

export function profileHeadline(p: Profile): string {
  const name = p.distro || p.os;
  return `${name}${p.wsl ? " (WSL)" : ""}, ${p.arch}, ${p.shell}${p.packageManager ? `, ${p.packageManager}` : ""}`;
}

/** The lines added to the model's system prompt. */
export function profilePrompt(p: Profile): string {
  const lines = [
    `Target system: ${p.distro || p.os}${p.wsl ? " running in WSL" : ""} (${p.os}, ${p.arch}). Shell: ${p.shell}.` +
      (p.packageManager ? ` Package manager: ${p.packageManager}.` : ""),
  ];
  if (p.userland === "bsd")
    lines.push("Use macOS/BSD command flags (e.g. sed -i '', stat -f, date -v), not GNU-only flags.");
  else if (p.userland === "busybox") lines.push("Commands are BusyBox versions with limited flags.");
  else if (p.userland === "gnu") lines.push("Commands are GNU versions.");
  if (p.installed.length) lines.push(`Installed tools: ${p.installed.join(", ")}.`);
  if (p.missing.length) lines.push(`Not installed (avoid): ${p.missing.join(", ")}.`);
  return lines.join("\n");
}
