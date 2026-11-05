import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import { version } from "../../package.json";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const REPO = "shubhamcodess/whatcmd";

/* version from the CLI's package.json, so the pill never goes stale */
$$("[data-version]").forEach((el) => (el.textContent = version));

/* ---------- theme ---------- */
$(".theme")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("wc-theme", next);
  } catch {}
});

/* ---------- install tabs + copy ---------- */
const cmdText = $("[data-cmd-text]");
$$(".cmd__tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".cmd__tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    cmdText.textContent = tab.dataset.cmd;
  }),
);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
$$("[data-copy-from]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const ok = await copyText($(btn.dataset.copyFrom).textContent.trim());
    const label = btn.querySelector("span");
    btn.dataset.done = String(ok);
    label.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => {
      btn.dataset.done = "false";
      label.textContent = "Copy";
    }, 1600);
  }),
);

/* ---------- reveal on scroll, bench bars ---------- */
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      if (e.target.classList.contains("bench")) e.target.dataset.seen = "true";
      io.unobserve(e.target);
    }
  },
  { threshold: 0.2, rootMargin: "0px 0px -40px 0px" },
);
$$(".reveal, .bench").forEach((el) => io.observe(el));

/* ---------- GitHub stars ---------- */
(async () => {
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  let n;
  try {
    n = Number(sessionStorage.getItem("wc-stars"));
  } catch {}
  if (!n) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { accept: "application/vnd.github+json" } });
      if (r.ok) n = (await r.json()).stargazers_count;
      try {
        if (n) sessionStorage.setItem("wc-stars", String(n));
      } catch {}
    } catch {}
  }
  if (!n) return; // no count yet (or rate-limited): the button still links to the repo
  $$("[data-stars]").forEach((el) => {
    el.textContent = `★ ${fmt(n)}`;
    el.hidden = false;
  });
})();

/* ---------- background dot field (same as mcp-token-optimizer) ---------- */
(() => {
  const canvas = $(".bgfield canvas");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  const still = reduced();
  let w = 0, h = 0, dpr = 1, dot = [237, 236, 232], hot = [247, 112, 63], mx = -9999, my = -9999, raf = 0, last = 0;
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const parse = (v, fb) => {
      const n = v.split(",").map((x) => Number(x.trim()));
      return n.length === 3 && n.every((x) => !Number.isNaN(x)) ? n : fb;
    };
    dot = parse(cs.getPropertyValue("--dot"), dot);
    hot = parse(cs.getPropertyValue("--dot-cut"), hot);
  };
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    const span = w + h * 0.6;
    const sweep = (((t / 11000) % 1) * 1.5 - 0.25) * span;
    const cols = Math.ceil(w / 26) + 1;
    const rows = Math.ceil(h / 26) + 1;
    for (let r = 0; r < rows; r++) {
      const y = r * 26 + 13;
      const fade = 1 - Math.min(1, y / (h * 1.1)) * 0.55;
      for (let c = 0; c < cols; c++) {
        const x = c * 26 + 13;
        const edge = Math.min(1, x / 140, (w - x) / 140);
        const s = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
        const rnd = s - Math.floor(s);
        let a = (0.11 + rnd * 0.07) * fade * Math.max(0.25, edge);
        let col = dot;
        let sz = 1.6;
        if (!still) {
          const d = x + y * 0.6 - sweep;
          if (d > -60 && d < 60 && rnd > 0.35) {
            col = hot;
            a += 0.22 * (1 - Math.abs(d) / 60);
          } else if (d <= -60 && d > -520 && rnd > 0.35) a *= 0.25 + 0.75 * ((-d - 60) / 460);
          a += Math.sin(t * 0.0011 + rnd * 40) * 0.025;
        }
        const dx = x - mx, dy = y - my, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          const k = 1 - dist / 150;
          a += 0.38 * k * k;
          sz += 1.2 * k;
        }
        if (a <= 0.01) continue;
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(a, 0.75)})`;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
  };
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (t - last < 33) return;
    last = t;
    draw(t);
  };
  readColors();
  size();
  draw(0);
  if (!still) raf = requestAnimationFrame(loop);
  new MutationObserver(() => {
    readColors();
    draw(performance.now());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", () => {
    size();
    draw(performance.now());
  });
  window.addEventListener("pointermove", (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (still) draw(0);
  }, { passive: true });
  document.addEventListener("pointerleave", () => {
    mx = my = -9999;
    if (still) draw(0);
  });
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && !still) raf = requestAnimationFrame(loop);
  });
})();

/* ---------- terminal demo ---------- */
/*
  Script steps:
    ["com", text]              grey comment
    ["cmd", text]              type a line at the prompt
    ["enter"]                  show the ↵ key
    ["prefill", text]          whatcmd replaces the typed line with the command
    ["run"]                    second Enter: the command runs
    ["out", text, cls?]        output line
    ["clear-line"]             Ctrl-U: drop the current line
    ["gap"] / ["wait", ms]
*/
const SCRIPT = [
  ["com", "# install once"],
  ["cmd", "npm install -g @shubhamcodess/whatcmd"],
  ["enter"],
  ["run"],
  ["out", "added 1 package in 2s"],
  ["cmd", "whatcmd init"],
  ["enter"],
  ["run"],
  ["out", "✔ System: macOS 15.6, arm64, zsh, brew", "t-ok"],
  ["out", "✔ Ollama 0.40.14 is running", "t-ok"],
  ["out", "✔ Model qwen2.5-coder:1.5b is ready", "t-ok"],
  ["out", "✔ Added the /w shortcut to ~/.zshrc", "t-ok"],
  ["gap"],
  ["com", "# ask in plain English; the command replaces your line"],
  ["cmd", "/w find files bigger than 100MB"],
  ["enter"],
  ["prefill", "find . -type f -size +100M"],
  ["wait", 900],
  ["run"],
  ["out", "./videos/launch-demo.mov"],
  ["out", "./docs/q3-report.pdf"],
  ["gap"],
  ["com", "# refine the last command with /w+  (v1.1)"],
  ["cmd", "/w+ only pdfs"],
  ["enter"],
  ["prefill", 'find . -type f -size +100M -name "*.pdf"'],
  ["wait", 700],
  ["cmd", "/w+ only in ~/Downloads", { fresh: true }],
  ["enter"],
  ["prefill", 'find ~/Downloads -type f -size +100M -name "*.pdf"'],
  ["wait", 800],
  ["run"],
  ["out", "/Users/you/Downloads/scan-2026.pdf"],
  ["gap"],
  ["cmd", "/w what's using port 8080"],
  ["enter"],
  ["prefill", "lsof -i :8080"],
  ["wait", 700],
  ["run"],
  ["out", "node   4127  you  23u  IPv6  TCP *:8080 (LISTEN)"],
  ["gap"],
  ["cmd", "/w tell me a joke"],
  ["enter"],
  ["out", "whatcmd: not a shell task, nothing generated", "t-warn"],
  ["clear-line"],
  ["cmd", "/w delete the build folder"],
  ["enter"],
  ["prefill", "rm -rf build"],
  ["out", "⚠ deletes files recursively. Your call: edit, run, or Ctrl-U", "t-warn"],
  ["wait", 2600],
];

(() => {
  const host = $("[data-term]");
  if (!host) return;
  const body = host.parentElement;
  let token = 0;
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(body);

  const sleep = async (ms, my) => {
    const end = performance.now() + ms;
    while (performance.now() < end || !visible || document.hidden) {
      if (my !== token) throw new Error("stop");
      await new Promise((r) => setTimeout(r, 40));
    }
    if (my !== token) throw new Error("stop");
  };
  const trim = () => {
    while (host.scrollHeight > body.clientHeight - 20 && host.children.length > 1) host.firstElementChild.remove();
  };
  const line = (cls) => {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    host.append(p);
    trim();
    return p;
  };
  const prompt = () => '<span class="t-ps">❯ </span>';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const caret = '<span class="caret"></span>';

  async function play(my) {
    host.innerHTML = "";
    let cur = null; // current prompt line
    let curText = "";
    let curAsk = ""; // what was typed (/w …) before whatcmd replaced the line
    const note = () => (curAsk && curText !== curAsk ? `<span class="t-com">  ← ${esc(curAsk)}</span>` : "");
    const fast = reduced();
    for (const [kind, text, extra] of SCRIPT) {
      if (kind === "com") {
        line("t-com appear").textContent = text;
        await sleep(fast ? 0 : 500, my);
      } else if (kind === "cmd") {
        if (cur) cur.innerHTML = prompt() + esc(curText) + note(); // leave the old line as-is
        cur = line("t-cmd");
        curText = "";
        curAsk = text.startsWith("/w") ? text : "";
        if (fast) {
          curText = text;
          cur.innerHTML = prompt() + esc(curText) + caret;
          continue;
        }
        await sleep(extra?.fresh ? 250 : 400, my);
        for (const ch of text) {
          curText += ch;
          cur.innerHTML = prompt() + esc(curText) + caret;
          await sleep(28 + Math.random() * 45, my);
        }
        await sleep(300, my);
      } else if (kind === "enter") {
        if (!cur) continue;
        cur.innerHTML = prompt() + esc(curText) + caret + '<span class="enter">↵</span>';
        await sleep(fast ? 0 : 450, my);
      } else if (kind === "prefill") {
        if (!cur) continue;
        await sleep(fast ? 0 : 180, my); // ~ model latency
        curText = text;
        cur.innerHTML = prompt() + `<span class="t-new">${esc(text)}</span>` + caret;
        await sleep(fast ? 0 : 600, my);
      } else if (kind === "run") {
        if (!cur) continue;
        cur.innerHTML = prompt() + esc(curText) + '<span class="enter">↵</span>' + note();
        cur = null;
        await sleep(fast ? 0 : 450, my);
      } else if (kind === "out") {
        line(`${extra || "t-out"} appear`).textContent = text;
        await sleep(fast ? 0 : 220, my);
      } else if (kind === "clear-line") {
        await sleep(fast ? 0 : 900, my);
        if (cur) cur.innerHTML = prompt() + '<span class="t-com">^U</span>';
        cur = null;
      } else if (kind === "gap") {
        line().innerHTML = "";
      } else if (kind === "wait") {
        await sleep(fast ? 0 : text, my);
      }
    }
    if (cur) cur.innerHTML = prompt() + esc(curText) + caret;
  }

  async function start() {
    const my = ++token;
    try {
      do {
        await play(my);
        if (reduced()) return; // static transcript, no loop
        await sleep(1800, my);
      } while (my === token);
    } catch {}
  }
  $("[data-replay]")?.addEventListener("click", start);
  start();
})();
