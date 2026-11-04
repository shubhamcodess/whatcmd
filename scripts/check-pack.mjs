// Checks what `npm pack` would ship: required files present, development files absent, scoped name.
// Usage: node scripts/check-pack.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!/^@[^/]+\/[^/]+$/.test(pkg.name)) {
  console.error(`package name must be scoped (@scope/name), got ${pkg.name}`);
  process.exit(1);
}
const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
// npm can print lifecycle headers (e.g. "> pkg@ver prepare") before the JSON, so take the array only.
const start = out.search(/^\[/m);
if (start < 0) {
  console.error("npm pack did not print a JSON array:\n" + out.slice(0, 500));
  process.exit(1);
}
const files = JSON.parse(out.slice(start))[0].files.map((f) => f.path);
const required = ["dist/cli.js", "README.md", "LICENSE", "package.json"];
const forbidden = [/\.test\.js$/, /^src\//, /^tests?\//, /^benchmarks\//, /^eval\//, /^\.github\//, /\.map$/];
let problems = 0;
for (const r of required) if (!files.includes(r)) { console.error(`missing from package: ${r}`); problems++; }
for (const f of files) for (const bad of forbidden) if (bad.test(f)) { console.error(`must not ship: ${f}`); problems++; }
if (problems) process.exit(1);
console.log(`pack ok: ${pkg.name}@${pkg.version}, ${files.length} files`);
