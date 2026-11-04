// Checks that every relative link and #anchor in the project's Markdown files resolves.
// Usage: node scripts/check-links.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKIP = new Set(["node_modules", "dist", ".git"]);

function markdownFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const slug = (heading) =>
  heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

let problems = 0;
const files = markdownFiles(ROOT);
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [rel, anchor] = target.split("#");
    if (rel === "" && anchor === undefined) continue;
    const full = rel === "" ? file : path.join(path.dirname(file), rel);
    if (!fs.existsSync(full)) {
      console.error(`broken link in ${path.relative(ROOT, file)}: ${target}`);
      problems++;
      continue;
    }
    if (anchor && full.endsWith(".md")) {
      const slugs = [...fs.readFileSync(full, "utf8").matchAll(/^#+\s+(.*)$/gm)].map((h) => slug(h[1]));
      if (!slugs.includes(anchor)) {
        console.error(`broken anchor in ${path.relative(ROOT, file)}: ${target}`);
        problems++;
      }
    }
  }
}
if (problems) {
  console.error(`${problems} broken link(s)`);
  process.exit(1);
}
console.log(`links ok in ${files.length} Markdown files`);
