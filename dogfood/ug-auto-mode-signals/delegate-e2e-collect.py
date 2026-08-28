#!/usr/bin/env python3
# Collector for delegate-e2e.sh: given one `claude -p` run's result JSON,
# the child's PreToolUse stderr log, and the isolated manifest dir + launch
# cwd, assemble one JSON row of the assertions README section (r)
# reports, and print it (one line, for the caller to append to the JSONL
# fixture). Never raises on a missing/malformed input file; every field
# degrades to null/false/a "not found" string rather than crashing the
# shell driver mid-run.
import argparse
import glob
import json
import os
import re


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001, best-effort fixture read
        return {"_read_error": str(exc)}


def read_text(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ""


def redact(text, child, parent):
    if child:
        text = text.replace(child, "<child-sid>")
    if parent:
        text = text.replace(parent, "<parent-sid>")
    return text


APPROVED_BY_RE = re.compile(
    r"^auto-mode:claude-code:(?P<mode>[^:;]+);delegated:(?P<parent>[0-9a-fA-F-]+)$"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", required=True)
    ap.add_argument("--child", required=True)
    ap.add_argument("--parent", required=True)
    ap.add_argument("--manifest-dir", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--stderr-log", required=True)
    ap.add_argument("--wrote-report", required=True, choices=["yes", "no"])
    ap.add_argument(
        "--marker-file",
        required=True,
        help="basename of the per-child touch target under --work (NOT a shared literal name: "
        "see delegate-e2e.sh's mkr() for why a shared name would make a later run's bash_ran "
        "check a false positive off a stale file from an earlier run)",
    )
    args = ap.parse_args()

    result = read_json(args.result)
    stderr_text = read_text(args.stderr_log)

    permission_denials = result.get("permission_denials")
    result_text = result.get("result")
    num_turns = result.get("num_turns")

    marker_path = os.path.join(
        args.manifest_dir, "harness.generated", ".approvals", args.child
    )
    marker = None
    approved_by = None
    approved_by_parsed = None
    if os.path.isfile(marker_path):
        marker = read_json(marker_path)
        approved_by = marker.get("approvedBy") if isinstance(marker, dict) else None
        if isinstance(approved_by, str):
            m = APPROVED_BY_RE.match(approved_by)
            if m:
                approved_by_parsed = {
                    "mode": m.group("mode"),
                    "delegated_parent_matches": m.group("parent") == args.parent,
                }

    reports_dir = os.path.join(args.work, ".understanding-gate", "reports")
    persisted_report = None
    persisted_report_status = None
    if os.path.isdir(reports_dir):
        for fp in sorted(glob.glob(os.path.join(reports_dir, "*.json"))):
            doc = read_json(fp)
            if isinstance(doc, dict) and doc.get("sessionId") == args.child:
                persisted_report = os.path.basename(fp)
                persisted_report_status = doc.get("approvalStatus")
                break

    created_file = os.path.isfile(os.path.join(args.work, args.marker_file))

    def has(pat):
        return bool(re.search(pat, stderr_text))

    # Two DIFFERENT stderr phrasings both mean "the delegation was verified
    # and used as key one" (auto-approve-path.ts): the delegation-ALONE
    # form fires when the payload's own permission_mode is NOT in
    # auto_approve.when, and the ADDITIVE form fires when it IS (this
    # script always launches with --permission-mode bypassPermissions,
    # which IS in `when` for every shape here, so real runs take the
    # additive form; the delegation-alone form is exercised by the
    # synthetic pre-run smoke tests with permission_mode: "default", not
    # by any claude -p run this collector processes). Both are matched so
    # the field reflects whether the delegation was checked and held, not
    # which of the two phrasings happened to fire.
    delegation_verified_alone = has(
        r"auto-approval key one: valid delegation from parent session"
    )
    delegation_verified_additive = has(
        r'auto-approval key one: permission_mode "[^"]*" in auto_approve\.when '
        r"\(a valid delegation from parent session [0-9a-fA-F-]+ is also present\)"
    )
    delegation_verified = delegation_verified_alone or delegation_verified_additive
    delegation_refused = None
    m = re.search(r"delegation for [0-9a-fA-F-]+ refused: ([a-z_]+): (.+)", stderr_text)
    if m:
        delegation_refused = {"reason": m.group(1), "detail_excerpt": m.group(2)[:200]}
    report_scan_timed_out = has(
        r"no Understanding Report for session [0-9a-fA-F-]+ reached its transcript within"
    )
    # The literal retry sentence (DELEGATION_REPORT_RETRY_INSTRUCTION) is
    # appended to the hook's STDOUT block JSON (blockJson in
    # hook-pre-tool-use.ts), never written to stderr. This script's
    # settings.json wiring does not tee that stdout to a file (Claude Code
    # consumes the hook's stdout itself as the permission decision), so
    # this collector cannot see the literal bytes from a real claude -p
    # run. `report_scan_timed_out` above is the reliable proxy: it is set
    # from the SAME conditional branch that unconditionally appends the
    # retry sentence to that call's stdout (hook-pre-tool-use.ts, the
    # `reportScanTimedOut ? DELEGATION_REPORT_RETRY_INSTRUCTION : null`
    # line), so report_scan_timed_out: true on a real run is code-traced
    # proof the sentence was in that call's stdout, without claiming this
    # script captured the bytes themselves.
    retry_instruction_present = None
    auto_approved = has(r"auto-approved via session marker by auto-mode:")
    cwd_mismatch = delegation_refused is not None and delegation_refused["reason"] == "cwd_mismatch"

    row = {
        "shape": args.shape,
        "wrote_report": args.wrote_report,
        "num_turns": num_turns,
        "result_text_excerpt": (result_text or "")[:200],
        "permission_denials_count": len(permission_denials)
        if isinstance(permission_denials, list)
        else None,
        "bash_ran": created_file,
        "marker_exists": marker is not None,
        "approved_by_redacted": redact(approved_by, args.child, args.parent)
        if approved_by
        else None,
        "approved_by_parsed": approved_by_parsed,
        "persisted_report_status": persisted_report_status,
        "delegation_verified": delegation_verified,
        "delegation_verified_form": "additive_with_mode"
        if delegation_verified_additive
        else ("alone" if delegation_verified_alone else None),
        "delegation_refused": delegation_refused,
        "report_scan_timed_out": report_scan_timed_out,
        "retry_instruction_present": retry_instruction_present,
        "auto_approved_stderr_line": auto_approved,
        "cwd_mismatch": cwd_mismatch,
        "ledger_fact": "ledger not wired in the isolated dir"
        if "grounding-mcp not declared in manifest" in stderr_text
        else ("present" if "wrote understanding-auto-approved" in stderr_text else "unknown"),
    }
    print(json.dumps(row, sort_keys=True))


if __name__ == "__main__":
    main()
