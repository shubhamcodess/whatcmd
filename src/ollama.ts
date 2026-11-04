export type OllamaErrorCode = "unreachable" | "model_missing" | "timeout" | "http";

export class OllamaError extends Error {
  constructor(message: string, readonly code: OllamaErrorCode) {
    super(message);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelInfo {
  name: string;
  size: number;
}

async function request(host: string, p: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  try {
    return await fetch(host + p, {
      ...init,
      headers: { "content-type": "application/json" },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError")
      throw new OllamaError(`Ollama did not answer within ${timeoutMs} ms`, "timeout");
    throw new OllamaError(`Cannot reach Ollama at ${host}`, "unreachable");
  }
}

export async function getVersion(host: string, timeoutMs = 1500): Promise<string> {
  const r = await request(host, "/api/version", {}, timeoutMs);
  if (!r.ok) throw new OllamaError(`Ollama answered HTTP ${r.status}`, "http");
  return ((await r.json()) as { version: string }).version;
}

export async function isUp(host: string): Promise<boolean> {
  try {
    await getVersion(host);
    return true;
  } catch {
    return false;
  }
}

export async function listModels(host: string): Promise<ModelInfo[]> {
  const r = await request(host, "/api/tags", {}, 5000);
  if (!r.ok) throw new OllamaError(`Ollama answered HTTP ${r.status}`, "http");
  const j = (await r.json()) as { models?: ModelInfo[] };
  return (j.models ?? []).map((m) => ({ name: m.name, size: m.size }));
}

const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
export const sameModel = (a: string, b: string) => norm(a) === norm(b);
export const hasModel = (models: ModelInfo[], name: string) => models.some((m) => sameModel(m.name, name));

function keepAliveValue(v: string): string | number {
  return /^-?\d+$/.test(v) ? Number(v) : v;
}

export async function chat(
  host: string,
  o: { model: string; messages: ChatMessage[]; temperature: number; keepAlive: string; timeoutMs: number },
): Promise<string> {
  const r = await request(
    host,
    "/api/chat",
    {
      method: "POST",
      body: JSON.stringify({
        model: o.model,
        messages: o.messages,
        stream: false,
        keep_alive: keepAliveValue(o.keepAlive),
        options: { temperature: o.temperature, num_predict: 96, stop: ["\n\n", "\n```\n"] },
      }),
    },
    o.timeoutMs,
  );
  if (!r.ok) {
    const body = await r.text();
    if (r.status === 404 && /not found/i.test(body))
      throw new OllamaError(`Model "${o.model}" is not downloaded`, "model_missing");
    throw new OllamaError(`Ollama error ${r.status}: ${body.slice(0, 200)}`, "http");
  }
  const j = (await r.json()) as { message?: { content?: string } };
  return j.message?.content ?? "";
}

/** Download a model, reporting progress. */
export async function pull(
  host: string,
  model: string,
  onProgress: (status: string, completed?: number, total?: number) => void,
): Promise<void> {
  const r = await request(host, "/api/pull", { method: "POST", body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) throw new OllamaError(`Pull failed: HTTP ${r.status} ${await r.text()}`, "http");
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
      if (j.error) throw new OllamaError(j.error, "http");
      onProgress(j.status ?? "", j.completed, j.total);
    }
  }
}
