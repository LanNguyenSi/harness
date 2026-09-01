// Direct coverage for the Risk-Classifier-only `sed` read-only floor, and
// for the deliberate ABSENCE of a `curl` one (task 2929c5b7, review round
// 4, decision D-013).
//
// WHY A SEPARATE FILE, and why every case runs through `classifyRisk`
// with an EMPTY classifier list: round 2 shipped these floors with
// coverage that was inert under mutation. Every sed/curl case in the
// intercept tests was ALSO matched by a `dangerous-shell` manifest
// pattern at `high`, so deleting the floor entirely left those tests
// green. Passing `[]` for `classifiers` removes the manifest from the
// picture, so the assertions below can only be satisfied by the floor
// itself.
import { describe, expect, it } from "vitest";
import { buildActionEnvelope, classifyRisk } from "../../src/runtime/index.js";
import type { ActionEnvelope, EnvelopeContext } from "../../src/runtime/index.js";
import type { ToolEvent } from "../../src/runtime/intercept.js";
import {
  isReadOnlyBashCommand,
  isReadOnlySedCommand,
} from "../../src/runtime/read-only-bash.js";

const CTX: EnvelopeContext = {
  cwd: "/work/repo",
  git: { repo: "repo", branch: "main", sha: "" },
  user: "agent",
  host: "host",
  now: new Date("2026-09-01T12:00:00.000Z"),
};

function bashEnvelope(command: string): ActionEnvelope {
  const event: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  return buildActionEnvelope(event, CTX);
}

/** The profile the floor alone produces: NO manifest patterns at all. */
function floorOnly(command: string) {
  return classifyRisk(bashEnvelope(command), []);
}

describe("sed read-only floor (Risk Classifier only, task 2929c5b7)", () => {
  it.each([
    ["numeric range print", "sed -n '1,5p' f"],
    ["extended-regex substitution to stdout", "sed -E 's/a/b/' f"],
    ["separate -e script", "sed -n -e '/x/p' f"],
    ["glued -e script", "sed -e 's/is/isnt/'"],
    ["last-line address (quoted $ is literal)", "sed -n '$p' f"],
    ["regex containing the letter w", "sed -n '/warning/p' f"],
    ["positional script plus file operand", "sed 's/a/b/' f"],
    ["long flags", "sed --posix --quiet '1p' f"],
  ])("floors %s to low", (_label, command) => {
    expect(isReadOnlySedCommand(command)).toBe(true);
    expect(floorOnly(command).severity).toBe("low");
  });

  // NEGATIVE CONTROL for the floor: a write-capable invocation of the
  // SAME binary must not be low. `-i` is the obvious one; the `w`
  // command, the `s///w` flag, `-f SCRIPTFILE` and GNU's `e` command are
  // the ones round 1's "without -i, sed only writes to stdout" premise
  // got wrong.
  it.each([
    ["clustered in-place", "sed -ni f"],
    ["long in-place with suffix", "sed --in-place=SUFFIX f"],
    ["glued in-place suffix", "sed -i.bak 's/a/b/' f"],
    ["s///w writes a file", "sed 's/a/b/w /etc/passwd' f"],
    ["w command writes a file", "sed -n 'w /etc/passwd' f"],
    ["-f runs an unexamined script", "sed -f script.sed f"],
    ["--file runs an unexamined script", "sed --file=script.sed f"],
    ["GNU e command executes a shell command", "sed '1e rm -rf /' f"],
    ["s///e executes the pattern space", "sed 's/a/b/e' f"],
    ["r reads an operator-named file", "sed -n 'r /etc/passwd' f"],
    ["unquoted expansion in the script", 'sed -n "/$X/p" f'],
    ["quoting hides a flag", 'sed "-i" f'],
  ])("does NOT floor %s", (_label, command) => {
    expect(isReadOnlySedCommand(command)).toBe(false);
    expect(floorOnly(command).severity).not.toBe("low");
  });
});

// D-013 (fix round 4): there is NO curl read-only floor, by design. The
// per-flag allowlist round 3 shipped was the third attempt at one and the
// second to leak: it allowlisted `-w`/`--write-out` as inert, but curl
// >= 8.3.0's `%output{FILE}` directive in that format string writes a
// local file (verified on curl 8.7.1), so `curl -s -w '%output{/etc/x}p'
// URL` floored to `low` and escaped the approval gate entirely.
//
// The recurring class is the premise, not the list: deciding a curl
// invocation is inert requires knowing every curl flag's write capability
// across curl versions. So curl stays UNCLASSIFIED like `ssh` and
// `node -e` (approval-gated by prong (b), never hard-blocked, never
// floored), and only its write-CAPABLE spellings are named, by the
// destructive floor, which raises them to `high`.
describe("curl has NO read-only floor (decision D-013, task 2929c5b7)", () => {
  it.each([
    ["plain read", "curl -sL URL"],
    ["HEAD request", "curl -I URL"],
    ["explicit GET", "curl -X GET URL"],
    ["quoted query-string URL", "curl -s 'https://h/p?a=b'"],
    ["write-out %output writes a local file (the round-3 hole)", "curl -s -w '%output{/etc/x}p' URL"],
    ["@file header ships a local file into the request", "curl -s -H @/etc/passwd URL"],
  ])("does NOT floor %s to low", (_label, command) => {
    expect(floorOnly(command).severity).not.toBe("low");
  });

  // The two write-capable spellings round 3 missed are now `high` via the
  // DESTRUCTIVE floor, with no manifest patterns in play.
  it.each([
    ["-w with a %output directive", "curl -s -w '%output{/etc/x}p' URL"],
    ["-H with an @file value", "curl -s -H @/etc/passwd URL"],
  ])("classifies %s as high via the destructive floor", (_label, command) => {
    const profile = floorOnly(command);
    expect(profile.classified).toBe(true);
    expect(profile.severity).toBe("high");
  });

  // NEGATIVE CONTROL for the two assertions above, and the whole point of
  // D-013: an ordinary read-only curl is neither floored low NOR raised to
  // high. It is genuinely UNCLASSIFIED, which prong (b) treats as
  // risk-bearing at the "high" rung: approval-gated, never hard-blocked.
  // Without this case, a floor that classified every curl `high` would
  // satisfy the block above.
  it("leaves an ordinary read-only curl genuinely unclassified", () => {
    const profile = floorOnly("curl -sL URL");
    expect(profile.classified).toBe(false);
    expect(profile.severity).toBeNull();
  });

  // curl gets no curl-SPECIFIC floor, but it is not "never floored": the
  // generic two-token `--help`/`--version` shape `isReadOnlyBashCommand`
  // already recognises for EVERY binary applies to curl too, exactly as
  // it did before this task (D-013 only removed the curl-specific
  // allowlist, not this pre-existing shared shape).
  it("floors curl --help to low via the generic --help/--version shape, unchanged by D-013", () => {
    expect(isReadOnlyBashCommand("curl --help")).toBe(true);
    const profile = floorOnly("curl --help");
    expect(profile.classified).toBe(true);
    expect(profile.severity).toBe("low");
  });
});

describe("the sed floor stays OUT of the shared read-only predicate", () => {
  // The load-bearing separation (review round 2's CRITICAL finding): the
  // understanding-gate PreToolUse blocker and the solution-acceptance
  // write-guard consume `isReadOnlyBashCommand` directly and short-circuit
  // on it. `sed` and `curl` were never accepted there before this task and
  // must not be now. `curl` no longer has a Risk-Classifier floor either
  // (D-013), but these pins stay: they guard the SHARED predicate, which is
  // a different gate from the Risk Classifier, and a future curl floor must
  // not be added there.
  // The write-guard side of this is pinned separately in
  // tests/cli/pack-hook-solution-acceptance-writeguard.test.ts.
  it.each([
    "sed -n p f",
    "sed -n '1p' f",
    "sed 's/a/b/' f",
    "curl URL",
    "curl -sL URL",
    "curl -I https://example.com",
  ])("isReadOnlyBashCommand(%j) is false", (command) => {
    expect(isReadOnlyBashCommand(command)).toBe(false);
  });
});
