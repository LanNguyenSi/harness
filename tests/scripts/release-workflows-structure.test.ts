import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Pins the structure of the publish chain: the npm publish must wait for the
// full CI, CI, publish and release must use one resolved commit, the GitHub
// Release is cut only after a successful publish, and a running publish or
// release is never cancelled. actionlint cannot see any of this.

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
  uses?: string;
  needs?: string | string[];
  with?: Record<string, unknown>;
  steps?: Step[];
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
};

function load(file: string): Workflow {
  return parse(
    readFileSync(join(process.cwd(), ".github/workflows", file), "utf8"),
  ) as Workflow;
}

const asList = (needs: string | string[] | undefined): string[] =>
  needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];

// One version table for both derivations: dist_tag_for on the publish side
// and the prerelease flag of release.yml must classify every version alike.
const DIST_TAG_CASES: Array<[string, string]> = [
  ["2.1.0", ""],
  ["2.1.0-rc.1", "next"],
  ["2.1.0-beta.0+build.5", "next"],
  ["2.1.0-alpha.2", "next"],
  ["2.1.0+build.5", ""],
  ["2.1.0+build-5", ""],
  ["2.1.0+sha.ab-cd", ""],
  ["2.1.0-rc.1+sha.ab-cd", "next"],
];

describe("publish-npm.yml", () => {
  const wf = load("publish-npm.yml");
  const publish = wf.jobs.publish as Job;
  const release = wf.jobs.release as Job;

  it("runs the reusable CI against the resolved commit", () => {
    expect(wf.jobs.ci?.uses).toBe("./.github/workflows/ci.yml");
    expect(asList(wf.jobs.ci?.needs)).toContain("resolve");
    expect(wf.jobs.ci?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("publish waits for CI and for the resolve job", () => {
    expect(asList(publish.needs)).toEqual(
      expect.arrayContaining(["ci", "resolve"]),
    );
  });

  it("publish checks out the resolved SHA, not the tag name", () => {
    const checkout = publish.steps?.find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("no job in the chain has a job-level `if:` (always() would publish past a red CI, or release past a failed publish)", () => {
    for (const name of ["resolve", "ci", "publish", "release"]) {
      expect(wf.jobs[name]?.if, `job ${name}`).toBeUndefined();
    }
  });

  // A GitHub Release must never exist for a tag whose publish did not
  // succeed: the release job is a job of this run that waits for `publish`
  // (and so, transitively, for CI), with no `if:` to override that.
  it("the release job calls release.yml after the publish job succeeded", () => {
    expect(release?.uses).toBe("./.github/workflows/release.yml");
    expect(asList(release?.needs)).toEqual(
      expect.arrayContaining(["publish", "resolve"]),
    );
    expect(release?.if).toBeUndefined();
  });

  it("the release job releases the resolved tag and commit", () => {
    expect(release?.with?.tag).toBe("${{ needs.resolve.outputs.tag }}");
    expect(release?.with?.sha).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("every job that gates the release is reachable from it through needs", () => {
    const reach = (name: string, seen = new Set<string>()): Set<string> => {
      for (const dep of asList(wf.jobs[name]?.needs)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          reach(dep, seen);
        }
      }
      return seen;
    };
    expect([...reach("release")].sort()).toEqual(["ci", "publish", "resolve"]);
  });

  it("grants contents: write to the release job only", () => {
    expect(wf.permissions?.contents).toBe("read");
    expect(wf.permissions?.["id-token"]).toBeUndefined();
    expect(release?.permissions?.contents).toBe("write");
    expect(release?.permissions?.["id-token"]).toBeUndefined();
    for (const name of ["resolve", "ci", "publish"]) {
      expect(wf.jobs[name]?.permissions?.contents, `job ${name}`).toBe("read");
    }
  });

  it("the publish step's other success exits are pinned: already published, and landed despite a non-zero exit", () => {
    const publishRun =
      publish.steps?.find((s) => s.name === "Publish")?.run ?? "";
    // Both are green outcomes that let the release job run, so each must end
    // the step right there, right after its notice, and only after the
    // attestation was found.
    expect(publishRun).toMatch(
      /if \[ -z "\$\{attestations\}" \]; then\n[\s\S]*?\n\s*fi\n\s*echo "::notice::\$\{pkg\}@\$\{version\} is already on the registry; nothing to publish\."\n\s*exit 0\n/,
    );
    expect(publishRun).toMatch(
      /if \[ -z "\$\{attestations\}" \]; then\n[\s\S]*?\n\s*fi\n\s*echo "::notice::\$\{pkg\}@\$\{version\} reached the registry despite a non-zero publish exit; treating as success\."\n\s*exit 0\n/,
    );
  });

  it("verifies the checkout is the resolved commit before setup-node and the build", () => {
    const steps = publish.steps ?? [];
    const verifyAt = steps.findIndex(
      (s) => s.name === "Verify checkout is the resolved commit",
    );
    expect(verifyAt).toBeGreaterThan(-1);
    const verify = steps[verifyAt] as Step;
    expect(verify.env?.EXPECTED_SHA).toBe("${{ needs.resolve.outputs.sha }}");
    expect(verify.run).toContain("git rev-parse HEAD");
    expect(verify.run).toMatch(/\[ "\$\{actual\}" != "\$\{EXPECTED_SHA\}" \]/);
    const setupAt = steps.findIndex((s) =>
      s.uses?.startsWith("actions/setup-node@"),
    );
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
    const publishRun =
      publish.steps?.find((s) => s.name === "Publish")?.run ?? "";
    const fnMatch = publishRun.match(/dist_tag_for\(\) \{[\s\S]*?\n\s*\}/);

    it("the Publish step defines the dist_tag_for shell function", () => {
      expect(
        fnMatch,
        "dist_tag_for function in the Publish step",
      ).not.toBeNull();
    });

    // Each version is its own case: stable (no tag), a bare prerelease,
    // a prerelease with build metadata, build metadata alone, a hyphen
    // inside build metadata (stable: semver says prerelease null), and a
    // prerelease plus such metadata. The replay spawns `sh` (on the
    // suite's spawn allowlist; `bash` is not): the snippet is POSIX sh,
    // which runs it identically under the workflow's bash on the runner
    // and under /bin/sh here and in CI (a bash on macOS, dash on the
    // Linux CI runner), so the derivation is shell-checked, not mocked.
    it.each(DIST_TAG_CASES)(
      "dist_tag_for %s under sh returns %s",
      (version, expected) => {
        const fn = fnMatch?.[0] ?? "dist_tag_for() { :; }";
        const r = spawnSync("sh", ["-c", `${fn}\ndist_tag_for "${version}"`], {
          encoding: "utf8",
        });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(expected);
      },
    );

    it("the Publish step derives dist_tag from the version and branches on it", () => {
      expect(publishRun).toContain('dist_tag=$(dist_tag_for "${version}")');
      expect(publishRun).toContain('if [ -z "${dist_tag}" ]; then');
      expect(publishRun).toContain(
        'npm publish --access public --provenance --tag "${dist_tag}"',
      );
      // The stable branch is the bare publish: no --tag at all, so npm keeps
      // its guard against moving `latest` backwards.
      expect(publishRun).toMatch(
        /^ +if npm publish --access public --provenance; then$/m,
      );
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
              expect(
                line,
                `job ${jobName} step ${step.name ?? step.uses}`,
              ).not.toMatch(/--tag\s+latest/);
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
  const raw = readFileSync(
    join(process.cwd(), ".github/workflows/release.yml"),
    "utf8",
  );
  const steps = wf.jobs.release?.steps ?? [];
  const checkout = steps.find((s) =>
    s.uses?.startsWith("actions/checkout@"),
  ) as Step;
  const versionStep = steps.find((s) => s.id === "version") as Step;
  const releaseStep = steps.find((s) =>
    s.uses?.startsWith("softprops/action-gh-release@"),
  ) as Step;

  // No trigger of its own: a tag push runs publish-npm.yml alone, and the
  // GitHub Release is created only through its `release` job.
  it("is only reusable: workflow_call is its sole trigger", () => {
    expect(Object.keys(wf.on ?? {})).toEqual(["workflow_call"]);
  });

  it("takes the tag and the resolved commit as required inputs", () => {
    const inputs = (
      wf.on?.workflow_call as {
        inputs?: Record<string, { required?: boolean; type?: string }>;
      }
    ).inputs;
    expect(Object.keys(inputs ?? {}).sort()).toEqual(["sha", "tag"]);
    for (const name of ["tag", "sha"]) {
      expect(inputs?.[name]?.required, name).toBe(true);
      expect(inputs?.[name]?.type, name).toBe("string");
    }
  });

  it("runs no CI of its own and has the single release job, with no `if:`", () => {
    expect(Object.keys(wf.jobs)).toEqual(["release"]);
    expect(wf.jobs.release?.if).toBeUndefined();
    expect(wf.jobs.release?.needs).toBeUndefined();
  });

  it("checks out the resolved commit, not the caller's ref", () => {
    expect(checkout.with?.ref).toBe("${{ inputs.sha }}");
    const verify = steps.find(
      (s) => s.name === "Verify checkout is the resolved commit",
    ) as Step;
    expect(verify.env?.EXPECTED_SHA).toBe("${{ inputs.sha }}");
    expect(verify.run).toMatch(/\[ "\$\{actual\}" != "\$\{EXPECTED_SHA\}" \]/);
  });

  it("refuses to release a tag that moved off the resolved commit", () => {
    const verify = steps.find(
      (s) => s.name === "Verify the tag still points at the resolved commit",
    ) as Step;
    expect(verify.env?.TAG_NAME).toBe("${{ inputs.tag }}");
    expect(verify.env?.EXPECTED_SHA).toBe("${{ inputs.sha }}");
    expect(verify.run ?? "").not.toContain("${{");
    expect(verify.run).toContain("refs/tags/${TAG_NAME}^{commit}");
    expect(verify.run).toMatch(/\[ "\$\{actual\}" != "\$\{EXPECTED_SHA\}" \]/);
    expect(steps.indexOf(verify)).toBeLessThan(steps.indexOf(releaseStep));
  });

  // In a called workflow github.ref_name is the CALLER's ref: the tag on a
  // push, the dispatch branch on a manual run. The inputs are the only
  // source that names the right tag on both paths.
  it("takes the tag from the input only, never from github.ref_name or the ref", () => {
    const structure = JSON.stringify(wf);
    expect(structure).not.toContain("github.ref");
    expect(structure).not.toContain("github.sha");
    expect(releaseStep.with?.tag_name).toBe("${{ inputs.tag }}");
  });

  it("grants contents: write to the release job only, and never id-token", () => {
    expect(wf.permissions?.contents).toBe("read");
    expect(wf.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.release?.permissions?.contents).toBe("write");
    expect(wf.jobs.release?.permissions?.["id-token"]).toBeUndefined();
    expect(raw).not.toMatch(/^\s*push:/m);
  });

  it("keys its concurrency group on the input tag, apart from the publish group", () => {
    expect(wf.concurrency?.group).toBe("release-${{ inputs.tag }}");
    expect(wf.concurrency?.group).not.toBe(
      load("publish-npm.yml").concurrency?.group,
    );
  });

  it("the version step derives prerelease from an env-bound tag and exports it", () => {
    expect(versionStep.env?.TAG_NAME).toBe("${{ inputs.tag }}");
    // The tag reaches the script only as an environment variable: a `${{ }}`
    // spliced into the run script would make the tag value script-syntax.
    expect(versionStep.run ?? "").not.toContain("${{");
    expect(versionStep.run).toContain(
      'echo "version=${version}" >> "$GITHUB_OUTPUT"',
    );
    expect(versionStep.run).toContain(
      'echo "prerelease=${prerelease}" >> "$GITHUB_OUTPUT"',
    );
  });

  it("the release step passes the version step's prerelease output to the action", () => {
    expect(releaseStep.with?.prerelease).toBe(
      "${{ steps.version.outputs.prerelease }}",
    );
  });

  // The version step's classification: the `case` block replayed under a
  // real `sh` (on the suite's spawn allowlist; `bash` is not) with the v
  // stripped in the harness (the step's own strip line is pinned above),
  // the same rule dist_tag_for applies on the publish side, so the two
  // derivations cannot silently drift apart. The snippet is POSIX sh.
  const classifyMatch = (versionStep.run ?? "").match(
    /case "\$\{version[^"]*\}" in\n[\s\S]*?\nesac/,
  );

  it("the version step carries the prerelease case block and strips the v prefix", () => {
    expect(
      classifyMatch,
      "classification block in the version step",
    ).not.toBeNull();
    expect(versionStep.run).toContain('version="${TAG_NAME#v}"');
  });

  it.each(
    DIST_TAG_CASES.map(([v, tag]): [string, string] => [
      `v${v}`,
      tag === "next" ? "true" : "false",
    ]),
  )(
    "the version step classifies %s under sh as prerelease=%s",
    (tag, expected) => {
      const block =
        classifyMatch?.[0] ??
        'case "${version}" in\n *) prerelease=unset ;;\nesac';
      const r = spawnSync(
        "sh",
        [
          "-c",
          `TAG_NAME="${tag}"\nversion="\${TAG_NAME#v}"\n${block}\nprintf '%s' "\${prerelease}"`,
        ],
        { encoding: "utf8" },
      );
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(expected);
    },
  );
});

describe.each(["publish-npm.yml", "release.yml"])("%s concurrency", (file) => {
  it("never cancels a running job", () => {
    const wf = load(file);
    expect(wf.concurrency?.group).toBeTruthy();
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});
