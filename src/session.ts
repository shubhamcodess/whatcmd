import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "./config.js";
import type { WebRef } from "./generate.js";

/**
 * Refinement state, one file per terminal session (shell PID), so tabs never mix.
 * Only the original request, the current command and a turn count are kept: each
 * refinement sends just those, so prompts don't grow with the number of turns.
 */

export const MAX_REFINES = 5;
export const SESSION_TTL_MS = 15 * 60 * 1000;

export interface Session {
  /** The original request ("find big files"), plus each change appended ("; only pdfs"). */
  ask: string;
  /** The last command whatcmd produced. */
  command: string;
  /** How many refinements were applied. */
  turns: number;
  /** The shell's last run command when this command was generated; unchanged later = nothing new was run. */
  lastSeen?: string;
  /** Web docs this command was made with; refinements reuse them instead of searching again. */
  web?: WebRef;
  at: number;
}

const dir = () => path.join(cacheDir(), "sessions");
const file = (id: string) => path.join(dir(), `${id.replace(/[^\w.-]/g, "_")}.json`);

export function loadSession(id: string, now = Date.now()): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(id), "utf8")) as Session;
    return now - s.at <= SESSION_TTL_MS ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(id: string, s: Omit<Session, "at">, now = Date.now()): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(id), JSON.stringify({ ...s, at: now }));
    // Housekeeping: drop sessions older than a day.
    for (const f of fs.readdirSync(dir())) {
      const p = path.join(dir(), f);
      if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
    }
  } catch {}
}

export function clearSession(id: string): void {
  try {
    fs.unlinkSync(file(id));
  } catch {}
}

const firstWord = (c: string) => c.trim().replace(/^(sudo|env|time|nohup)\s+/, "").split(/\s+/)[0] ?? "";

/**
 * What to refine: the command the user actually ran if it is the generated one or an
 * edited version of it (same program), otherwise the generated command. The exit status
 * only counts when it belongs to that command.
 */
export function refineBase(
  generated: string,
  lastRun?: string,
  lastStatus?: number,
  lastSeen?: string,
): { command: string; status?: number } {
  const ran = lastRun?.trim();
  if (ran && ran === lastSeen?.trim()) return { command: generated }; // nothing run since we generated
  if (ran && (ran === generated.trim() || firstWord(ran) === firstWord(generated)))
    return { command: ran, status: lastStatus };
  return { command: generated };
}
