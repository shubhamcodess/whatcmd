import type { Config } from "./config.js";
import { detectProfile, type Profile } from "./env.js";
import { check, looksLikeProgramName, type RejectReason, type Verdict } from "./gate.js";
import { ground, type Reference } from "./ground.js";
import { alternativeFor, autofix, isCalculatorAnswer, isDegenerate, isInjection, lint, looksLikeShellTask, type LintIssue } from "./lint.js";
import { chat, type ChatMessage } from "./ollama.js";
import { buildMessages, copiesExample, missingHint } from "./prompt.js";

export type Result =
  | { kind: "command"; command: string; warnings: string[]; debug: DebugInfo }
  | { kind: "rejected"; reason: RejectReason; debug: DebugInfo };

export interface DebugInfo {
  refs: Reference[];
  /** What grounding found or why it found nothing, per candidate word. */
  groundNotes: string[];
  outputs: string[];
  /** Why each retry happened. */
  retries: string[];
  timings: Record<string, number>;
  messages: ChatMessage[];
}

const MAX_CALLS = 3;
const since = (t: number) => Math.round(performance.now() - t);
const normWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The model sometimes just repeats the request ("zorbctl set the level to 5"). */
export function echoesRequest(cmd: string, ask: string): boolean {
  if (normWords(cmd) === normWords(ask)) return true;
  if (/[-./|>$=<'"`*]/.test(cmd)) return false;
  const words = normWords(cmd).split(" ");
  if (words.length < 4) return false;
  const askWords = new Set(normWords(ask).split(" "));
  return words.filter((w) => askWords.has(w)).length / words.length >= 0.8;
}

interface Checked {
  verdict: Verdict;
  issues: LintIssue[];
  echoed: boolean;
}

function evaluate(raw: string, ask: string, profile: Profile): Checked {
  const verdict = check(raw);
  if (!verdict.ok) return { verdict, issues: [], echoed: false };
  if (isDegenerate(verdict.command)) return { verdict: { ok: false, reason: "unparseable" }, issues: [], echoed: false };
  if (isCalculatorAnswer(verdict.command, ask)) return { verdict: { ok: false, reason: "chat-reply" }, issues: [], echoed: false };
  const command = autofix(verdict.command, profile);
  const fixed: Verdict = command === verdict.command ? verdict : { ...verdict, command };
  const echoed = echoesRequest(command, ask) || copiesExample(command, ask);
  return { verdict: fixed, issues: lint(command, profile), echoed };
}

/** Lower is better: used to keep the better of two attempts. */
function badness(c: Checked): number {
  if (!c.verdict.ok) return 100;
  return (c.echoed ? 10 : 0) + c.verdict.missing.length * 2 + c.issues.length;
}

function fixHint(c: Checked, profile: Profile): string {
  if (!c.verdict.ok) return "";
  const parts: string[] = [];
  if (c.echoed)
    parts.push("That repeats the request instead of giving a command. Use the program's real options (see the documentation above if given).");
  if (c.verdict.missing.length) {
    const alts = c.verdict.missing.map((m) => [m, alternativeFor(m, profile)] as const).filter(([, a]) => a);
    parts.push(missingHint(c.verdict.missing, profile));
    for (const [m, a] of alts) parts.push(`Instead of ${m}, use: ${a}.`);
  }
  for (const i of c.issues) parts.push(i.hint + ".");
  return parts.join(" ");
}

export async function generate(ask: string, cfg: Config): Promise<Result> {
  const debug: DebugInfo = { refs: [], groundNotes: [], outputs: [], retries: [], timings: {}, messages: [] };
  if (!/[a-z0-9]/i.test(ask)) return { kind: "rejected", reason: "empty", debug };
  if (isInjection(ask)) return { kind: "rejected", reason: "not-a-shell-task", debug };

  const profile = cfg.profile ?? detectProfile();

  const t = performance.now();
  debug.refs = cfg.grounding ? ground(ask, profile, 2, debug.groundNotes) : [];
  debug.timings.groundMs = since(t);

  let messages = buildMessages(ask, profile, debug.refs, cfg.notes);
  debug.messages = messages;
  const call = async () => {
    const t0 = performance.now();
    const out = await chat(cfg.host, { model: cfg.model, messages, temperature: cfg.temperature, keepAlive: cfg.keepAlive, timeoutMs: cfg.timeoutMs });
    debug.timings[`llm${debug.outputs.length + 1}Ms`] = since(t0);
    debug.outputs.push(out);
    return out;
  };
  const retry = async (prev: string, hint: string, why: string) => {
    debug.retries.push(why);
    messages.push({ role: "assistant", content: prev }, { role: "user", content: hint });
    return evaluate(await call(), ask, profile);
  };

  let best = evaluate(await call(), ask, profile);

  // Second chance for a NONE on a request that is clearly about this computer.
  if (!best.verdict.ok && best.verdict.reason === "not-a-shell-task" && looksLikeShellTask(ask)) {
    // A fresh prompt with extra question-style examples. NONE stays allowed, so real
    // non-shell questions that slipped past looksLikeShellTask can still be refused.
    debug.retries.push("second-chance");
    messages = buildMessages(ask, profile, debug.refs, cfg.notes, true);
    debug.messages = messages;
    const again = evaluate(await call(), ask, profile);
    if (again.verdict.ok && !again.echoed) best = again;
  }

  // One fix-up retry for missing tools, OS-specific mistakes or an echoed request.
  if (best.verdict.ok && badness(best) > 0 && debug.outputs.length < MAX_CALLS) {
    const prev = best.verdict.command;
    const again = await retry(prev, fixHint(best, profile), "fix");
    if (again.verdict.ok) {
      if (badness(again) <= badness(best)) best = again;
    } else if (!/\s/.test(prev)) {
      // A bare word like "hi" that the model then calls NONE was a chat reply, not a command.
      return { kind: "rejected", reason: again.verdict.reason, debug };
    }
  }

  const v = best.verdict;
  if (!v.ok) return { kind: "rejected", reason: v.reason, debug };
  if (best.echoed) return { kind: "rejected", reason: "chat-reply", debug };
  const first = v.missing[0];
  if (first && !looksLikeProgramName(first)) return { kind: "rejected", reason: "chat-reply", debug };

  const warnings = [
    ...v.missing.map((m) => `${m} is not installed on this system`),
    ...best.issues.map((i) => i.warning),
    ...v.risks,
  ];
  return { kind: "command", command: v.command, warnings, debug };
}
