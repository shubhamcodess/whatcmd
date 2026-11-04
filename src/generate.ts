import type { Config } from "./config.js";
import { detectProfile } from "./env.js";
import { check, looksLikeProgramName, type RejectReason } from "./gate.js";
import { ground, type Reference } from "./ground.js";
import { chat, type ChatMessage } from "./ollama.js";
import { buildMessages, missingHint } from "./prompt.js";

export type Result =
  | { kind: "command"; command: string; warnings: string[]; debug: DebugInfo }
  | { kind: "rejected"; reason: RejectReason; debug: DebugInfo };

export interface DebugInfo {
  refs: Reference[];
  outputs: string[];
  timings: Record<string, number>;
  messages: ChatMessage[];
}

const since = (t: number) => Math.round(performance.now() - t);

export async function generate(ask: string, cfg: Config): Promise<Result> {
  const debug: DebugInfo = { refs: [], outputs: [], timings: {}, messages: [] };
  if (!/[a-z0-9]/i.test(ask)) return { kind: "rejected", reason: "empty", debug };

  const profile = cfg.profile ?? detectProfile();

  const t = performance.now();
  debug.refs = cfg.grounding ? ground(ask, profile) : [];
  debug.timings.groundMs = since(t);

  const messages = buildMessages(ask, profile, debug.refs, cfg.notes);
  debug.messages = messages;
  const call = async () => {
    const t0 = performance.now();
    const out = await chat(cfg.host, { model: cfg.model, messages, temperature: cfg.temperature, keepAlive: cfg.keepAlive, timeoutMs: cfg.timeoutMs });
    debug.timings[`llm${debug.outputs.length + 1}Ms`] = since(t0);
    debug.outputs.push(out);
    return out;
  };

  let verdict = check(await call());

  // One retry when the command uses a program that isn't installed here.
  if (verdict.ok && verdict.missing.length) {
    messages.push({ role: "assistant", content: verdict.command }, { role: "user", content: missingHint(verdict.missing, profile) });
    const second = check(await call());
    if (second.ok) {
      if (second.missing.length <= verdict.missing.length) verdict = second;
    } else if (!/\s/.test(verdict.command)) {
      // A bare word like "hi" that the model then calls NONE was a chat reply, not a command.
      return { kind: "rejected", reason: second.reason, debug };
    }
    // Otherwise keep the first command; it is shown with a "not installed" warning.
  }

  if (!verdict.ok) return { kind: "rejected", reason: verdict.reason, debug };

  const first = verdict.missing[0];
  if (first && !looksLikeProgramName(first)) return { kind: "rejected", reason: "chat-reply", debug };

  const warnings = [
    ...verdict.missing.map((m) => `${m} is not installed on this system`),
    ...verdict.risks,
  ];
  return { kind: "command", command: verdict.command, warnings, debug };
}
