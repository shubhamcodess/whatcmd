import type { Profile } from "./env.js";
import { profilePrompt } from "./env.js";
import type { Reference } from "./ground.js";
import type { ChatMessage } from "./ollama.js";

const BASE_RULES = `You convert a request into ONE shell command for the user's system. Output only the command, no explanation, no backticks.`;
const RULES = `${BASE_RULES}
If the request is not a task that can be done with a shell command on this computer, output exactly: NONE`;

/** Few-shot turns. Includes NONE examples so the model learns to refuse non-shell requests. */
export const SHOTS: [string, string][] = [
  ["list all files including hidden ones", "ls -la"],
  ["write a haiku about cats", "NONE"],
  ["find python files modified in the last day", "find . -name '*.py' -mtime -1"],
  ["what is the capital of Japan", "NONE"],
  ["show disk usage of current folder in human readable form", "du -sh ."],
];

/** Extra positive examples for the second-chance prompt, which has no NONE option. */
const FORCE_SHOTS: [string, string][] = [
  ["how long has this machine been up", "uptime"],
  ["show who changed each line of main.c", "git blame main.c"],
  ["what are the name servers for example.org", "dig NS example.org"],
];

const COMMON_WORDS = new Set("the and for with all show list this that from into what are how has who each your".split(" "));
const contentWords = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !COMMON_WORDS.has(w)));

/**
 * Small models sometimes answer with an example's command verbatim ("ls -la" for anything).
 * That's a copy, not an answer, when the request shares no content word with that example.
 */
export function copiesExample(command: string, ask: string): boolean {
  const askWords = contentWords(ask);
  return SHOTS.some(
    ([q, a]) => a !== "NONE" && a === command && ![...contentWords(q)].some((w) => askWords.has(w)),
  );
}

export function systemPrompt(profile: Profile | undefined, notes: string, allowNone = true): string {
  const parts = [allowNone ? RULES : BASE_RULES];
  if (profile) parts.push(profilePrompt(profile));
  if (notes.trim()) parts.push(`User preferences: ${notes.trim()}`);
  return parts.join("\n\n");
}

/**
 * System prompt + shots stay identical between requests so Ollama can reuse its prompt cache;
 * per-request references go into the final user message only.
 */
export function buildMessages(
  ask: string,
  profile: Profile | undefined,
  refs: Reference[],
  notes: string,
  allowNone = true,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(profile, notes, allowNone) }];
  const shots = allowNone ? SHOTS : [...SHOTS.filter(([, a]) => a !== "NONE"), ...FORCE_SHOTS];
  for (const [u, a] of shots) messages.push({ role: "user", content: u }, { role: "assistant", content: a });
  let content = ask.trim();
  if (refs.length) {
    const docs = refs.map((r) => `[${r.name} — from this computer's ${r.source === "package" ? "package database" : r.source === "man" ? "man page" : "--help"}]\n${r.text}`);
    content = `Local documentation:\n${docs.join("\n\n")}\n\nRequest: ${content}`;
  }
  messages.push({ role: "user", content });
  return messages;
}

export function missingHint(missing: string[], profile: Profile | undefined): string {
  const list = missing.join(", ");
  const pm = profile?.packageManager;
  return (
    `${list} ${missing.length > 1 ? "are" : "is"} not installed on this computer. ` +
    `Answer again with a command that uses installed tools only` +
    (pm ? `, or if the task truly needs it, the ${pm} command that installs it.` : ".") +
    ` If the request is not a shell task, output exactly: NONE`
  );
}
