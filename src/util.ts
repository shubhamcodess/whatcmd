import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const whichCache = new Map<string, string | null>();

function isExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH without spawning a process. */
export function which(name: string): string | null {
  const hit = whichCache.get(name);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  if (name.includes("/")) {
    found = isExecutable(name) ? name : null;
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, name);
      if (isExecutable(p)) {
        found = p;
        break;
      }
    }
  }
  whichCache.set(name, found);
  return found;
}

export function clearWhichCache(): void {
  whichCache.clear();
}

export interface RunResult {
  ok: boolean;
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Run a program synchronously with a timeout. Never throws. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 2000,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}
