#!/usr/bin/env python3
# PreToolUse + PostToolUse hook behind README section (g): a stand-in for
# the "block-and-retry" capture shape. On PreToolUse it scans the session
# transcript (role-aware, token-based, same detector as transcript-probe.py)
# and answers allow when the report is present, deny with an instruction
# otherwise. Every invocation appends one JSON line to $PROBE_OUT.
import json, os, sys

d = json.load(sys.stdin)
tp = d.get("transcript_path")
ev = d.get("hook_event_name")
HEAD = "# Understanding Report"
TOKEN = "gnidnatsrednu"
DENY_REASON = (
    "Understanding gate: no Understanding Report is visible for this session yet. "
    "If you already wrote one, simply retry the same command once. If you have not, "
    "first write a section starting with the heading '# Understanding Report' containing "
    "the line 'Token: ' followed by the word understanding spelled backwards, then retry the command."
)


def has_report():
    try:
        lines = open(tp).read().splitlines()
    except FileNotFoundError:
        return False, -1
    for i, raw in enumerate(lines, 1):
        try:
            j = json.loads(raw)
        except Exception:
            continue
        if j.get("type") != "assistant":
            continue
        c = (j.get("message") or {}).get("content")
        if isinstance(c, str):
            txt = c
        else:
            txt = "\n".join(x.get("text", "") for x in (c or []) if isinstance(x, dict) and x.get("type") == "text")
        if HEAD in txt and TOKEN in txt:
            return True, i
    return False, len(lines)


found, idx = has_report()
rec = {
    "event": ev,
    "session": d.get("session_id"),
    "tool": d.get("tool_name"),
    "cmd": (d.get("tool_input") or {}).get("command"),
    "report_found": found,
    "line_or_len": idx,
}
if ev == "PreToolUse":
    if found:
        rec["decision"] = "allow"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "retryprobe: report found"}}))
    else:
        rec["decision"] = "deny"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": DENY_REASON}}))
with open(os.environ["PROBE_OUT"], "a") as f:
    f.write(json.dumps(rec) + "\n")
