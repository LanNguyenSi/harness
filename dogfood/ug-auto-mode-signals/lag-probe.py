#!/usr/bin/env python3
# PreToolUse hook behind README section (o): lag-distribution probe. Same
# role-aware, token-based detector as transcript-probe.py (heading plus the
# reversed-word token, assistant entries only), but polls every 25 ms up to
# 5 s (vs section (e)'s 100 ms / 3 s) to build a per-run latency
# distribution rather than confirm a single sample, and additionally
# records the winning entry's own `isSidechain` and `sessionId` fields so
# the fixture documents that shape directly rather than by inference.
import json, os, sys, time

d = json.load(sys.stdin)
tp = d.get("transcript_path")
ev = d.get("hook_event_name")
HEAD = "# Understanding Report"
TOKEN = "gnidnatsrednu"
POLL_S = float(os.environ.get("PROBE_POLL_S", "0.025"))
MAX_S = float(os.environ.get("PROBE_MAX_S", "5.0"))


def scan():
    """Return (line_count, first_assistant_report_line, isSidechain, sessionId)
    for the first matching entry, or (line_count, None, None, None)."""
    try:
        lines = open(tp).read().splitlines()
    except FileNotFoundError:
        return -1, None, None, None
    for i, raw in enumerate(lines, 1):
        try:
            j = json.loads(raw)
        except Exception:
            continue
        if j.get("type") != "assistant":
            continue
        m = j.get("message") or {}
        c = m.get("content")
        if isinstance(c, str):
            txt = c
        elif isinstance(c, list):
            txt = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        else:
            txt = ""
        if HEAD in txt and TOKEN in txt:
            return len(lines), i, j.get("isSidechain"), j.get("sessionId")
    return len(lines), None, None, None


n0, a0, side0, sid0 = scan()
first_seen_ms = 0 if a0 else None
side, sid = side0, sid0
if a0 is None:
    t_start = time.time()
    while time.time() - t_start < MAX_S:
        time.sleep(POLL_S)
        n, a, s, si = scan()
        if a is not None:
            first_seen_ms = int((time.time() - t_start) * 1000)
            a0 = a
            side, sid = s, si
            break

out = {
    "event": ev,
    "tool": d.get("tool_name"),
    "mode": d.get("permission_mode"),
    "payload_session": d.get("session_id"),
    "lines_t0": n0,
    "report_visible_t0": first_seen_ms == 0,
    "first_seen_after_ms": first_seen_ms,
    "assistant_report_line": a0,
    "entry_isSidechain": side,
    "entry_sessionId": sid,
}
with open(os.environ["PROBE_OUT"], "a") as f:
    f.write(json.dumps(out) + "\n")

# Optional, opt-in debug/evidence aid: copy the transcript as it stands at
# the end of this hook's own wait window to a fixed path, so a run that
# never detects the report within MAX_S can still be inspected. No effect
# unless PROBE_TRANSCRIPT_COPY is set; never used by the -p lag-probe.sh.
copy_to = os.environ.get("PROBE_TRANSCRIPT_COPY")
if copy_to:
    try:
        with open(tp) as src, open(copy_to, "w") as dst:
            dst.write(src.read())
    except FileNotFoundError:
        pass
