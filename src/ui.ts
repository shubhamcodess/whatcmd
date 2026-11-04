import readline from "node:readline/promises";

const colorOn = (s: NodeJS.WriteStream) => Boolean(s.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string, stream: NodeJS.WriteStream = process.stderr): string {
  return colorOn(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = (t: string, s?: NodeJS.WriteStream) => paint("1", t, s);
export const dim = (t: string, s?: NodeJS.WriteStream) => paint("2", t, s);
export const red = (t: string, s?: NodeJS.WriteStream) => paint("31", t, s);
export const green = (t: string, s?: NodeJS.WriteStream) => paint("32", t, s);
export const yellow = (t: string, s?: NodeJS.WriteStream) => paint("33", t, s);
export const cyan = (t: string, s?: NodeJS.WriteStream) => paint("36", t, s);

export const err = (line: string) => process.stderr.write(line + "\n");
export const ok = (line: string) => err(`${green("✔")} ${line}`);
export const warn = (line: string) => err(`${yellow("!")} ${line}`);
export const fail = (line: string) => err(`${red("✘")} ${line}`);
export const info = (line: string) => err(`  ${dim(line)}`);

export const canPrompt = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, def: boolean): Promise<boolean> {
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
