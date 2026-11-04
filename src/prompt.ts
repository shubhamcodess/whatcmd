import type { Profile } from "./env.js";
import { profilePrompt } from "./env.js";
import type { Reference } from "./ground.js";
import type { ChatMessage } from "./ollama.js";

const RULES = `You convert a request into ONE shell command for the user's system. Output only the command, no explanation, no backticks.
If the request is not a task that can be done with a shell command on this computer, output exactly: NONE`;

/** Few-shot turns. Includes NONE examples so the model learns to refuse non-shell requests. */
export const SHOTS: [string, string][] = [
  ["list all files including hidden ones", "ls -la"],
  ["write a haiku about cats", "NONE"],
  ["find python files modified in the last day", "find . -name '*.py' -mtime -1"],
  ["what is the capital of Japan", "NONE"],
  ["show disk usage of current folder in human readable form", "du -sh ."],
];

export function systemPrompt(profile: Profile | undefined, notes: string): string {
  const parts = [RULES];
  if (profile) parts.push(profilePrompt(profile));
  if (notes.trim()) parts.push(`User preferences: ${notes.trim()}`);
  return parts.join("\n\n");
}

/**
 * System prompt + shots stay identical between requests so Ollama can reuse its prompt cache;
 * per-request references go into the final user message only.
 */
export function buildMessages(ask: string, profile: Profile | undefined, refs: Reference[], notes: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(profile, notes) }];
  for (const [u, a] of SHOTS) messages.push({ role: "user", content: u }, { role: "assistant", content: a });
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
