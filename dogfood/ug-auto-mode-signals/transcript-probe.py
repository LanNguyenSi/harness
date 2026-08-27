#!/usr/bin/env python3
# PreToolUse + Stop hook behind README section (e), second version.
# Role-aware: only transcript entries of type "assistant" count, and a hit
# needs BOTH the report heading and the discriminating token that the
# prompt never spells out (the word "understanding" reversed). The first
# version of this probe matched the bare string anywhere in the transcript,
# which the user prompt itself contained, so it could not discriminate.
# Output: one JSON line per hook invocation appended to $PROBE_OUT.
import json, os, sys, time

d = json.load(sys.stdin)
tp = d.get("transcript_path")
ev = d.get("hook_event_name")
HEAD = "# Understanding Report"
TOKEN = "gnidnatsrednu"
POLL_S = float(os.environ.get("PROBE_POLL_S", "0.1"))
MAX_S = float(os.environ.get("PROBE_MAX_S", "3.0"))


def scan():
    """Return (line_count, first_assistant_report_line, first_user_mention_line)."""
    try:
        lines = open(tp).read().splitlines()
    except FileNotFoundError:
        return -1, None, None
    a = None
    u = None
    for i, raw in enumerate(lines, 1):
        try:
            j = json.loads(raw)
        except Exception:
            continue
        t = j.get("type")
        m = j.get("message") or {}
        c = m.get("content")
        if isinstance(c, str):
            txt = c
        elif isinstance(c, list):
            txt = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            txt = ""
        if t == "assistant" and a is None and HEAD in txt and TOKEN in txt:
            a = i
        if t == "user" and u is None and "Understanding Report" in txt:
            u = i
    return len(lines), a, u


n0, a0, u0 = scan()
first_seen_ms = 0 if a0 else None
if a0 is None:
    t_start = time.time()
    while time.time() - t_start < MAX_S:
        time.sleep(POLL_S)
        n, a, u = scan()
        if a is not None:
            first_seen_ms = int((time.time() - t_start) * 1000)
            a0 = a
            break
n_end, a_end, u_end = scan()
out = {
    "event": ev,
    "tool": d.get("tool_name"),
    "mode": d.get("permission_mode"),
    "session": d.get("session_id"),
    "lines_t0": n0,
    "assistant_report_line_t0": a0 if first_seen_ms == 0 else None,
    "user_prompt_line": u0,
    "report_visible_t0": first_seen_ms == 0,
    "first_seen_after_ms": first_seen_ms,
    "assistant_report_line_final": a_end,
    "lines_final": n_end,
}
if ev == "Stop":
    lam = d.get("last_assistant_message") or ""
    out["last_assistant_message_has_report"] = (HEAD in lam and TOKEN in lam)
with open(os.environ["PROBE_OUT"], "a") as f:
    f.write(json.dumps(out) + "\n")
