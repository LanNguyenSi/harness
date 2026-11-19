import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Pins the structure of the publish chain: the npm publish must wait for the
// full CI, CI and publish must use one resolved commit, and a running publish
// or release is never cancelled. actionlint cannot see any of this.

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  permissions?: Record<string, string>;
  uses?: string; needs?: string | string[]; with?: Record<string, unknown>; steps?: Step[] };
type Workflow = {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
};

function load(file: string): Workflow {
  return parse(readFileSync(join(process.cwd(), ".github/workflows", file), "utf8")) as Workflow;
}

const asList = (needs: string | string[] | undefined): string[] =>
  needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];

describe("publish-npm.yml", () => {
  const wf = load("publish-npm.yml");
  const publish = wf.jobs.publish as Job;

  it("runs the reusable CI against the resolved commit", () => {
    expect(wf.jobs.ci?.uses).toBe("./.github/workflows/ci.yml");
    expect(asList(wf.jobs.ci?.needs)).toContain("resolve");
    expect(wf.jobs.ci?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("publish waits for CI and for the resolve job", () => {
    expect(asList(publish.needs)).toEqual(expect.arrayContaining(["ci", "resolve"]));
  });

  it("publish checks out the resolved SHA, not the tag name", () => {
    const checkout = publish.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("no job in the chain has a job-level `if:` (always() would publish past a red CI)", () => {
    for (const name of ["resolve", "ci", "publish"]) {
      expect(wf.jobs[name]?.if, `job ${name}`).toBeUndefined();
    }
  });

  it("verifies the checkout is the resolved commit before setup-node and the build", () => {
    const steps = publish.steps ?? [];
    const verifyAt = steps.findIndex((s) => s.name === "Verify checkout is the resolved commit");
    expect(verifyAt).toBeGreaterThan(-1);
    const verify = steps[verifyAt] as Step;
    expect(verify.env?.EXPECTED_SHA).toBe("${{ needs.resolve.outputs.sha }}");
    expect(verify.run).toContain("git rev-parse HEAD");
    expect(verify.run).toMatch(/\[ "\$\{actual\}" != "\$\{EXPECTED_SHA\}" \]/);
    const setupAt = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
    const buildAt = steps.findIndex((s) => s.run === "npm run build");
    expect(setupAt).toBeGreaterThan(verifyAt);
    expect(buildAt).toBeGreaterThan(verifyAt);
  });

  it("grants id-token: write to the publish job only", () => {
    expect(wf.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.resolve?.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.ci?.permissions?.["id-token"]).toBeUndefined();
    expect(publish.permissions?.["id-token"]).toBe("write");
    expect(publish.permissions?.contents).toBe("read");
  });

  it("no publish step is skipped by an `if:` (CI failure must stop the job)", () => {
    for (const step of publish.steps ?? []) {
      expect(step.if, `step ${step.name ?? step.uses}`).toBeUndefined();
    }
  });

  // Prerelease dist-tag derivation: npm >= 11.5.1 refuses a prerelease
  // publish without an explicit --tag, and refuses to implicitly apply
  // `latest` to a version below the highest published stable one. So a
  // prerelease must name `next` and a stable version must name no tag.
  describe("prerelease dist-tag derivation", () => {
    const publishRun = publish.steps?.find((s) => s.name === "Publish")?.run ?? "";
    const fnMatch = publishRun.match(/dist_tag_for\(\) \{[\s\S]*?\n\s*\}/);

    it("the Publish step defines the dist_tag_for shell function", () => {
      expect(fnMatch, "dist_tag_for function in the Publish step").not.toBeNull();
    });

    // Each version is its own case: stable (no tag), a bare prerelease,
    // a prerelease with build metadata, build metadata alone, a hyphen
    // inside build metadata (stable: semver says prerelease null), and a
    // prerelease plus such metadata. The replay spawns `sh` (on the
    // suite's spawn allowlist; `bash` is not): the snippet is POSIX sh,
    // which runs it identically under the workflow's bash on the runner
    // and under /bin/sh here and in CI (a bash on macOS, dash on the
    // Linux CI runner), so the derivation is shell-checked, not mocked.
    it.each([
      ["2.1.0", ""],
      ["2.1.0-rc.1", "next"],
      ["2.1.0-beta.0+build.5", "next"],
      ["2.1.0+build.5", ""],
      ["2.1.0+build-5", ""],
      ["2.1.0+sha.ab-cd", ""],
      ["2.1.0-rc.1+sha.ab-cd", "next"],
    ])("dist_tag_for %s under sh returns %s", (version, expected) => {
      const fn = fnMatch?.[0] ?? "dist_tag_for() { :; }";
      const r = spawnSync("sh", ["-c", `${fn}\ndist_tag_for "${version}"`], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(expected);
    });

    it("the Publish step derives dist_tag from the version and branches on it", () => {
      expect(publishRun).toContain('dist_tag=$(dist_tag_for "${version}")');
      expect(publishRun).toContain('if [ -z "${dist_tag}" ]; then');
      expect(publishRun).toContain('npm publish --access public --provenance --tag "${dist_tag}"');
      // The stable branch is the bare publish: no --tag at all, so npm keeps
      // its guard against moving `latest` backwards.
      expect(publishRun).toMatch(/^ +if npm publish --access public --provenance; then$/m);
    });

    // Single assignment: a fallback like `dist_tag=${dist_tag:-next}`
    // after the derivation, or `dist_tag=next` before the retry loop,
    // would silently route stable publishes under `next`, and no other
    // test in this file sees the value the publish branches on.
    it("the Publish step assigns dist_tag exactly once, from dist_tag_for", () => {
      expect(publishRun.match(/\bdist_tag=/g) ?? []).toHaveLength(1);
      expect(publishRun).toContain('dist_tag=$(dist_tag_for "${version}")');
    });

    it("no npm publish anywhere in the workflow carries --tag latest", () => {
      for (const [jobName, job] of Object.entries(wf.jobs)) {
        for (const step of job.steps ?? []) {
          for (const line of (step.run ?? "").split("\n")) {
            if (line.includes("npm publish")) {
              expect(line, `job ${jobName} step ${step.name ?? step.uses}`).not.toMatch(/--tag\s+latest/);
            }
          }
        }
      }
    });

    // Every successful publish must end the step right there: without the
    // `exit 0` a published version falls through to the failure-handling
    // tail of the retry loop (sleep 5, npm view, attestation read). The
    // publish-npm.yml file itself is not changed by this, the pin is
    // test-only: each publish-success branch is an `if`/`elif` whose body
    // is exactly the ::notice::Published echo and the exit 0.
    it("each npm publish success branch ends with its Published notice and exit 0", () => {
      expect(publishRun).toMatch(
        /if npm publish --access public --provenance; then\n\s*echo "::notice::Published \$\{pkg\}@\$\{version\} on attempt \$\{attempt\}\."\n\s*exit 0\n/,
      );
      expect(publishRun).toMatch(
        /elif npm publish --access public --provenance --tag "\$\{dist_tag\}"; then\n\s*echo "::notice::Published \$\{pkg\}@\$\{version\} under \$\{dist_tag\} on attempt \$\{attempt\}\."\n\s*exit 0\n/,
      );
    });
  });
});

describe("release.yml", () => {
  const wf = load("release.yml");
  const steps = wf.jobs.release?.steps ?? [];
  const versionStep = steps.find((s) => s.id === "version") as Step;
  const releaseStep = steps.find((s) => s.uses?.startsWith("softprops/action-gh-release@")) as Step;

  it("the version step derives prerelease from an env-bound tag and exports it", () => {
    expect(versionStep.env?.TAG_NAME).toBe("${{ github.ref_name }}");
    // The tag reaches the script only as an environment variable: a `${{ }}`
    // spliced into the run script would make the tag value script-syntax.
    expect(versionStep.run ?? "").not.toContain("${{");
    expect(versionStep.run).toContain('echo "version=${version}" >> "$GITHUB_OUTPUT"');
    expect(versionStep.run).toContain('echo "prerelease=${prerelease}" >> "$GITHUB_OUTPUT"');
  });

  it("the release step passes the version step's prerelease output to the action", () => {
    expect(releaseStep.with?.prerelease).toBe("${{ steps.version.outputs.prerelease }}");
  });

  // The version step's classification: the `case` block replayed under a
  // real `sh` (on the suite's spawn allowlist; `bash` is not) with the v
  // stripped in the harness (the step's own strip line is pinned above),
  // the same rule dist_tag_for applies on the publish side, so the two
  // derivations cannot silently drift apart. The snippet is POSIX sh.
  const classifyMatch = (versionStep.run ?? "").match(/case "\$\{version[^"]*\}" in\n[\s\S]*?\nesac/);

  it("the version step carries the prerelease case block and strips the v prefix", () => {
    expect(classifyMatch, "classification block in the version step").not.toBeNull();
    expect(versionStep.run).toContain('version="${TAG_NAME#v}"');
  });

  it.each([
    ["v2.1.0", "false"],
    ["v2.1.0-rc.1", "true"],
    ["v2.1.0+build-5", "false"],
  ])("the version step classifies %s under sh as prerelease=%s", (tag, expected) => {
    const block = classifyMatch?.[0] ?? 'case "${version}" in\n *) prerelease=unset ;;\nesac';
    const r = spawnSync("sh", ["-c", `TAG_NAME="${tag}"\nversion="\${TAG_NAME#v}"\n${block}\nprintf '%s' "\${prerelease}"`], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(expected);
  });
});

describe.each(["publish-npm.yml", "release.yml"])("%s concurrency", (file) => {
  it("never cancels a running job", () => {
    const wf = load(file);
    expect(wf.concurrency?.group).toBeTruthy();
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});
