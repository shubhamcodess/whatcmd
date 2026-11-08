import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): just enough to
 * start a server, call one tool and shut it down. No dependencies.
 */

export class McpError extends Error {
  constructor(message: string, readonly code: "spawn" | "timeout" | "protocol" | "tool") {
    super(message);
  }
}

export interface ToolResult {
  text: string;
  isError: boolean;
  structured?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stderr = "";
  private exited: Error | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
  ) {}

  /** Spawn the server and run the initialize handshake. */
  async start(timeoutMs: number): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    child.stderr.setEncoding("utf8");
    // Keep only the tail: servers log progress here; it's shown in errors only.
    child.stderr.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    const fail = (e: Error) => {
      this.exited = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    child.on("error", (e) => fail(new McpError(`cannot start ${this.command}: ${e.message}`, "spawn")));
    child.on("exit", (code, signal) =>
      fail(new McpError(`${this.command} exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`, "spawn")),
    );

    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "whatcmd", version: "0" } },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const text = (r.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    return { text, isError: r.isError === true, structured: r.structuredContent };
  }

  /** Close stdin (servers exit on EOF), then kill if it lingers. Never throws. */
  async close(graceMs = 1500): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve();
        }, 500).unref();
      }, graceMs);
      t.unref();
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        child.kill("SIGTERM");
      }
    });
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not ours (stray stdout from the server)
      }
      if (typeof msg.id !== "number") continue; // notifications and server requests are ignored
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new McpError(msg.error.message ?? "error", "protocol"));
      else p.resolve(msg.result);
    }
  }

  private write(msg: unknown): void {
    if (!this.child) throw new McpError("not started", "protocol");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        } catch {}
        reject(new McpError(`${method} took longer than ${timeoutMs} ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(t);
        reject(e as Error);
      }
    });
  }
}
