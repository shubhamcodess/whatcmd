// Prints the CHANGELOG.md section for one version. Used as the GitHub release notes.
// Usage: node scripts/release-notes.mjs 0.1.0
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const lines = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`no "## [${version}]" section in CHANGELOG.md; add it before releasing`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith("## [") || /^\[[^\]]+\]:\s/.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`the "## [${version}]" section is empty`);
  process.exit(1);
}
console.log(body);
