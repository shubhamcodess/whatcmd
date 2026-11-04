#!/usr/bin/env python3
"""Drive real interactive shells through a pty and check the /w shortcut.

Usage: python3 harness/hooks.py [--shells=zsh,bash] [--only=prefill,...] [--out=PATH]
Rows are appended to results/A/results.jsonl by default (config A runs all hook cases).
"""
import json, os, pty, re, select, shutil, signal, subprocess, sys, time

ROOT = os.path.expanduser("~/cmdkit-bench")
BIN = os.path.join(ROOT, "bin")
SANDBOX = os.path.join(ROOT, "sandbox")
RESULTS_DEFAULT = os.path.join(os.environ.get("BENCH_RESULTS", os.path.join(ROOT, "results")), "A", "results.jsonl")
SHELL_PATHS = {"zsh": "/bin/zsh", "bash": "/bin/bash"}
SCENARIOS = ["prefill", "second-enter-runs", "special-chars", "rejected", "normal-unaffected",
             "custom-prefix", "risk-warning", "no-substitution", "empty-request", "ollama-down"]

args = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "1") for a in sys.argv[1:] if a.startswith("--"))
SHELLS = args.get("shells", "zsh,bash").split(",")
ONLY = set(args["only"].split(",")) if "only" in args else None
OUT = args.get("out", RESULTS_DEFAULT)

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[=>]|\r")


def strip(s):
    return ANSI.sub("", s)


def env_for(home, extra=None):
    e = {
        "PATH": BIN + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": home,
        "TERM": "xterm",
        "LANG": "C",
        "PS1": "$ ",
        "PROMPT": "$ ",
        "NO_COLOR": "1",
        "TMPDIR": os.path.join(home, "tmp"),
        "WHATCMD_CONFIG_DIR": os.path.join(home, ".config", "whatcmd"),
        "WHATCMD_CACHE_DIR": os.path.join(home, ".cache", "whatcmd"),
    }
    e.update(extra or {})
    return e


def start(shell, home, cwd, extra=None):
    env = env_for(home, extra)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execve(SHELL_PATHS[shell], [SHELL_PATHS[shell], "-i"], env)
    return pid, fd


def read_some(fd, seconds):
    out = b""
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            break
        r, _, _ = select.select([fd], [], [], min(0.1, remaining))
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
    return out.decode(errors="replace")


def wait_for(fd, pred, timeout):
    """Read until pred(stripped_text) is true or timeout. Returns the raw text read."""
    text = ""
    end = time.time() + timeout
    while time.time() < end:
        text += read_some(fd, 0.25)
        if pred(strip(text)):
            break
    return text


def send(fd, s):
    os.write(fd, s.encode())


def kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass


def whatcmd(home, work, *argv, extra=None):
    return subprocess.run(["whatcmd", *argv], env=env_for(home, extra), cwd=work,
                          capture_output=True, text=True, timeout=240)


def sandbox_home(shell):
    home = os.path.join(SANDBOX, f"home-{shell}")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, "work"))
    os.makedirs(os.path.join(home, "tmp"))
    os.makedirs(os.path.join(home, ".config", "whatcmd"), exist_ok=True)
    rc = os.path.join(home, ".zshrc" if shell == "zsh" else ".bashrc")
    with open(rc, "w") as f:
        f.write("# benchmark sandbox rc file (one comment line)\n")
    return home, os.path.join(home, "work"), rc


def setup_shell(shell):
    home, work, rc = sandbox_home(shell)
    env = env_for(home, {"SHELL": SHELL_PATHS[shell]})
    r = subprocess.run(["whatcmd", "init", "--yes"], env=env, cwd=work, capture_output=True, text=True, timeout=300)
    text = open(rc).read()
    if "# >>> whatcmd >>>" not in text:
        raise RuntimeError(f"rc file {rc} lacks '# >>> whatcmd >>>' after init (exit {r.returncode}): {r.stderr[-300:]}")
    return home, work, rc, r


def tail(text, n=300):
    return strip(text).replace("\n", " | ")[-n:]


# ---- scenarios: each returns (pass, got, error) ----

def scen_prefill(shell, home, work):
    real = os.path.realpath(work)
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w print the current working directory\r")
        text = wait_for(fd, lambda t: "pwd" in t, 25)
        text += read_some(fd, 1.0)
        t = strip(text)
        ok = "pwd" in t and real not in t
        return ok, tail(t), None
    finally:
        kill(pid)


def scen_second_enter(shell, home, work):
    real = os.path.realpath(work)
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w print the current working directory\r")
        wait_for(fd, lambda t: "pwd" in t, 25)
        send(fd, "\r")
        text = strip(wait_for(fd, lambda t: real in t, 8))
        return real in text, tail(text), None
    finally:
        kill(pid)


def scen_special_chars(shell, home, work):
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w what's eating > 100MB in *this* folder; really?\r")
        text = strip(read_some(fd, 20))
        send(fd, "\x15")
        read_some(fd, 1.0)
        names = os.listdir(work)
        no_files = "100MB" not in names and "really?" not in names
        send(fd, "echo alive-$((1+1))\r")
        alive = strip(wait_for(fd, lambda t: "alive-2" in t, 6))
        ok = no_files and "alive-2" in alive
        return ok, f"files={names} {tail(alive, 160)}", None
    finally:
        kill(pid)


def scen_rejected(shell, home, work):
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w tell me a joke\r")
        text = strip(wait_for(fd, lambda t: "not a shell task" in t, 25))
        send(fd, "\x15")
        read_some(fd, 1.0)
        send(fd, "echo alive-$((1+1))\r")
        after = strip(wait_for(fd, lambda t: "alive-2" in t, 6))
        ok = "not a shell task" in text and "alive-2" in after and "command not found" not in text
        return ok, tail(text + after, 300), None
    finally:
        kill(pid)


def scen_normal(shell, home, work):
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "echo bench-$((40+2))\r")
        text = strip(wait_for(fd, lambda t: "bench-42" in t, 6))
        return "bench-42" in text, tail(text), None
    finally:
        kill(pid)


def scen_custom_prefix(shell, home, work):
    real = os.path.realpath(work)
    env = env_for(home)
    r = whatcmd(home, work, "config", "set", "prefix", ",")
    if r.returncode != 0:
        return False, tail(r.stderr), f"config set prefix failed: {r.stderr[-200:]}"
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, ", print the current working directory\r")
        text = strip(wait_for(fd, lambda t: "pwd" in t, 25))
        text += strip(read_some(fd, 1.0))
        ok = "pwd" in text and real not in text
        return ok, tail(text), None
    finally:
        kill(pid)
        whatcmd(home, work, "config", "set", "prefix", "/w")


def scen_risk_warning(shell, home, work):
    build = os.path.join(work, "build")
    os.makedirs(build, exist_ok=True)
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w delete the build folder and everything in it\r")
        text = strip(wait_for(fd, lambda t: "deletes files recursively" in t, 25))
        # Never press Enter again in this scenario.
        send(fd, "\x15")
        read_some(fd, 1.0)
        exists = os.path.isdir(build)
        ok = "deletes files recursively" in text and exists
        return ok, tail(text), None
    finally:
        kill(pid)


def scen_no_substitution(shell, home, work):
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w list files named $(touch pwned)\r")
        text = strip(read_some(fd, 15))
        send(fd, "\x15")
        read_some(fd, 1.0)
        exists = os.path.exists(os.path.join(work, "pwned"))
        return (not exists), f"pwned_exists={exists} {tail(text, 200)}", None
    finally:
        kill(pid)


def scen_empty_request(shell, home, work):
    pid, fd = start(shell, home, work)
    try:
        read_some(fd, 1.5)
        send(fd, "/w \r")
        text = strip(read_some(fd, 4))
        send(fd, "\x15")
        read_some(fd, 1.0)
        send(fd, "echo alive-$((1+1))\r")
        after = strip(wait_for(fd, lambda t: "alive-2" in t, 6))
        return "alive-2" in after, tail(text + after, 300), None
    finally:
        kill(pid)


def scen_ollama_down(shell, home, work):
    pid, fd = start(shell, home, work, {"WHATCMD_HOST": "127.0.0.1:1"})
    try:
        read_some(fd, 1.5)
        send(fd, "/w list files\r")
        text = strip(wait_for(fd, lambda t: "Cannot reach Ollama" in t, 20))
        send(fd, "\x15")
        read_some(fd, 1.0)
        return "Cannot reach Ollama" in text, tail(text), None
    finally:
        kill(pid)


FUNCS = {
    "prefill": scen_prefill, "second-enter-runs": scen_second_enter, "special-chars": scen_special_chars,
    "rejected": scen_rejected, "normal-unaffected": scen_normal, "custom-prefix": scen_custom_prefix,
    "risk-warning": scen_risk_warning, "no-substitution": scen_no_substitution,
    "empty-request": scen_empty_request, "ollama-down": scen_ollama_down,
}


def bash_is_modern():
    try:
        out = subprocess.run([SHELL_PATHS["bash"], "--version"], capture_output=True, text=True).stdout
        m = re.search(r"version (\d+)\.", out)
        return bool(m and int(m.group(1)) >= 4)
    except OSError:
        return False


def record(rows):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "a") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def main():
    rows = []
    for shell in SHELLS:
        if shell == "bash" and not bash_is_modern():
            for sc in SCENARIOS:
                if ONLY and sc not in ONLY:
                    continue
                rows.append({"id": f"hook-bash-{sc}", "category": "hook", "input": f"bash / {sc}", "pass": None,
                             "got": None, "warnings": [], "refs": [], "outcome": None, "ms": None, "llm_calls": None,
                             "error": "skipped: bash < 4"})
            print("bash scenarios skipped: system bash is < 4 (macOS /bin/bash 3.2)")
            continue
        home, work, rc, r = setup_shell(shell)
        print(f"{shell}: init exit {r.returncode}; rc file has whatcmd block")
        for sc in SCENARIOS:
            if ONLY and sc not in ONLY:
                continue
            t0 = time.time()
            try:
                ok, got, err = FUNCS[sc](shell, home, work)
            except Exception as e:  # keep going on any crash
                ok, got, err = False, None, f"exception: {e}"
            ms = round((time.time() - t0) * 1000)
            rows.append({"id": f"hook-{shell}-{sc}", "category": "hook", "input": f"{shell} / {sc}", "pass": bool(ok),
                         "got": got, "warnings": [], "refs": [], "outcome": None, "ms": ms, "llm_calls": None, "error": err})
            print(f"{'PASS' if ok else 'FAIL'} hook-{shell}-{sc} {ms}ms {err or ''}")
            # the custom-prefix scenario leaves the prefix reset; re-create work dir state for the next scenario
            os.makedirs(work, exist_ok=True)
    record(rows)
    print(f"appended {len(rows)} hook rows to {OUT}")


if __name__ == "__main__":
    main()
