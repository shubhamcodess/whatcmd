import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "./env.js";

export interface Config {
  /** Ollama model name, e.g. "qwen2.5-coder:1.5b". */
  model: string;
  /** Ollama server URL. */
  host: string;
  temperature: number;
  /** How long Ollama keeps the model in memory after a request ("2h", "30m", "-1" = forever). */
  keepAlive: string;
  timeoutMs: number;
  /** What you type in the shell before your request. */
  prefix: string;
  /** Feed docs of tools/packages you mention into the prompt. */
  grounding: boolean;
  /** Free-text notes added to every prompt, e.g. "prefer ripgrep over grep". */
  notes: string;
  /** Look up docs on the web (via tiny-browse) when local docs aren't enough. Sends queries to search engines. */
  web: boolean;
  /** How to start tiny-browse: a command or a path to its cli.js. Empty = the installed dependency, then PATH. */
  webCommand: string;
  /** Max time for one web lookup, including starting tiny-browse. */
  webTimeoutMs: number;
  /** Detected system profile (set by `whatcmd init` / `whatcmd profile --refresh`). */
  profile?: Profile;
}

export const DEFAULT_MODEL = "qwen2.5-coder:1.5b";

export const DEFAULTS: Config = {
  model: DEFAULT_MODEL,
  host: "http://127.0.0.1:11434",
  temperature: 0,
  keepAlive: "2h",
  timeoutMs: 30000,
  prefix: "/w",
  grounding: true,
  notes: "",
  web: false,
  webCommand: "",
  webTimeoutMs: 10000,
};

type KeyType = "string" | "number" | "boolean";
export const SETTABLE: Record<string, { type: KeyType; help: string }> = {
  model: { type: "string", help: "Ollama model to use" },
  host: { type: "string", help: "Ollama server URL" },
  temperature: { type: "number", help: "0 = deterministic (recommended)" },
  keepAlive: { type: "string", help: 'keep model loaded: "2h", "30m", "-1" = forever' },
  timeoutMs: { type: "number", help: "max time for one model call" },
  prefix: { type: "string", help: "shell trigger, default /w" },
  grounding: { type: "boolean", help: "use local docs of tools you mention" },
  notes: { type: "string", help: "extra instructions added to every prompt" },
  web: { type: "boolean", help: "look up docs on the web via tiny-browse when unsure (off = fully local)" },
  webCommand: { type: "string", help: "command or cli.js path that starts tiny-browse" },
  webTimeoutMs: { type: "number", help: "max time for one web lookup" },
};

export function configDir(): string {
  return (
    process.env.WHATCMD_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "whatcmd")
  );
}

export function cacheDir(): string {
  return (
    process.env.WHATCMD_CACHE_DIR ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "whatcmd")
  );
}

export const configPath = () => path.join(configDir(), "config.json");

/** Accepts the same forms as OLLAMA_HOST: "host", "host:port", ":port", "http(s)://host[:port]". */
export function normalizeHost(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  const hadScheme = /^https?:\/\//i.test(s);
  if (!hadScheme) s = "http://" + (s.startsWith(":") ? "127.0.0.1" + s : s);
  const u = new URL(s);
  if (u.hostname === "0.0.0.0" || u.hostname === "") u.hostname = "127.0.0.1";
  if (!hadScheme && !u.port) u.port = "11434";
  return u.toString().replace(/\/+$/, "");
}

export function readStored(): Partial<Config> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

export function writeStored(next: Partial<Config>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n");
}

export function saveStored(patch: Partial<Config>): void {
  writeStored({ ...readStored(), ...patch });
}

/** Effective config: defaults < config file < environment variables. */
export function loadConfig(): Config {
  const stored = readStored();
  const c: Config = { ...DEFAULTS, ...stored };
  if (!stored.host && process.env.OLLAMA_HOST) c.host = process.env.OLLAMA_HOST;
  if (process.env.WHATCMD_HOST) c.host = process.env.WHATCMD_HOST;
  if (process.env.WHATCMD_MODEL) c.model = process.env.WHATCMD_MODEL;
  const web = process.env.WHATCMD_WEB;
  if (web && /^(1|true|on|yes)$/i.test(web)) c.web = true;
  else if (web && /^(0|false|off|no)$/i.test(web)) c.web = false;
  try {
    c.host = normalizeHost(c.host);
  } catch {
    c.host = DEFAULTS.host;
  }
  return c;
}

export class ConfigError extends Error {}

export function coerce(key: string, raw: string): string | number | boolean {
  const spec = SETTABLE[key];
  if (!spec) throw new ConfigError(`Unknown key "${key}". Keys: ${Object.keys(SETTABLE).join(", ")}`);
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number`);
    if (key === "temperature" && (n < 0 || n > 2)) throw new ConfigError("temperature must be between 0 and 2");
    if (key === "webTimeoutMs" && n < 1000) throw new ConfigError("webTimeoutMs must be at least 1000");
    if (key === "timeoutMs" && n < 500) throw new ConfigError("timeoutMs must be at least 500");
    return n;
  }
  if (spec.type === "boolean") {
    if (/^(true|on|yes|1)$/i.test(raw)) return true;
    if (/^(false|off|no|0)$/i.test(raw)) return false;
    throw new ConfigError(`${key} must be true or false`);
  }
  if (key === "host") return normalizeHost(raw);
  if (key === "prefix" && !/^[^\s'"\\`$]+$/.test(raw))
    throw new ConfigError("prefix must be one word without spaces, quotes, $ or backslashes");
  if (key === "model" && !raw.trim()) throw new ConfigError("model cannot be empty");
  return raw;
}

export function setKey(key: string, raw: string): void {
  saveStored({ [key]: coerce(key, raw) } as Partial<Config>);
}

export function unsetKey(key: string): void {
  if (!SETTABLE[key]) throw new ConfigError(`Unknown key "${key}"`);
  const s = readStored() as Record<string, unknown>;
  delete s[key];
  writeStored(s as Partial<Config>);
}
