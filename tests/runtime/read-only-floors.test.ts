// Direct coverage for the Risk-Classifier-only `sed` / `curl` read-only
// floors (task 2929c5b7, review round 3).
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
  isReadOnlyCurlCommand,
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

describe("curl read-only floor (Risk Classifier only, task 2929c5b7)", () => {
  it.each([
    ["short cluster", "curl -sL URL"],
    ["cluster plus a header flag", "curl -sSf -H 'A: b' URL"],
    ["HEAD request", "curl -I URL"],
    ["explicit GET", "curl -X GET URL"],
    ["lowercase get is accepted case-insensitively", "curl -X get URL"],
    ["quoted query-string URL", "curl -s 'https://h/p?a=b'"],
  ])("floors %s to low", (_label, command) => {
    expect(isReadOnlyCurlCommand(command)).toBe(true);
    expect(floorOnly(command).severity).toBe("low");
  });

  // NEGATIVE CONTROL for the floor: every write-capable curl spelling the
  // round-2 denylist missed, plus the body/method ones it caught. All of
  // them must forfeit, and none may end up `low`.
  it.each([
    ["--json body", "curl --json '{}' URL"],
    ["-F multipart form", "curl -F file=@x URL"],
    ["--form-string", "curl --form-string a=b URL"],
    ["lowercase non-GET method", "curl -X post URL"],
    ["value-less -X consumes the URL as its method", "curl -X URL"],
    ["cluster hiding -d", "curl -sd @x URL"],
    ["cluster with glued method", "curl -sXPOST URL"],
    ["cluster with glued DELETE", "curl -sXDELETE URL"],
    ["cluster hiding -T", "curl -sT x URL"],
    ["cluster hiding -F", "curl -sF file=@x URL"],
    ["-o writes a local file", "curl -o /etc/passwd URL"],
    ["--output writes a local file", "curl --output /etc/passwd URL"],
    ["-O writes a remote-named file", "curl -O URL"],
    ["-D writes the response headers", "curl -D /etc/h URL"],
    ["-c writes a cookie jar", "curl -c /etc/c URL"],
    ["--trace-ascii writes a trace file", "curl --trace-ascii /etc/t URL"],
    ["-K reads flags from a file this scan never opens", "curl -K flags.conf URL"],
    ["--config reads flags from a file", "curl --config flags.conf URL"],
    ["unquoted expansion can inject flags", "curl $FLAGS URL"],
    ["quoting hides a flag", 'curl "-o" /etc/passwd URL'],
  ])("does NOT floor %s", (_label, command) => {
    expect(isReadOnlyCurlCommand(command)).toBe(false);
    expect(floorOnly(command).severity).not.toBe("low");
  });
});

describe("the sed/curl floors stay OUT of the shared read-only predicate", () => {
  // The load-bearing separation (review round 2's CRITICAL finding): the
  // understanding-gate PreToolUse blocker and the solution-acceptance
  // write-guard consume `isReadOnlyBashCommand` directly and short-circuit
  // on it. `sed` and `curl` were never accepted there before this task and
  // must not be now. The write-guard side of this is pinned separately in
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
