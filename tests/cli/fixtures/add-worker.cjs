// Worker for tests/cli/add.test.ts — concurrency check.
// Mirrors what `harness add cli ...` does under the hood: take the lock,
// read the manifest, parse + mutate Document AST, write back. Uses the
// same proper-lockfile options as src/io/lock.ts. Self-contained so the
// test does not depend on the TS build artefact.
const fs = require("node:fs");
const path = require("node:path");
const lockfile = require("proper-lockfile");
const { parseDocument } = require("yaml");

const args = JSON.parse(process.argv[2]);
const { manifestPath, suffix } = args;

const lockPath = path.join(path.dirname(manifestPath), ".harness.lock");
if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, "");

(async () => {
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
    realpath: false,
  });
  try {
    const yaml = fs.readFileSync(manifestPath, "utf8");
    const doc = parseDocument(yaml);
    const entry = { name: `cli-${suffix}`, binary: "noop" };
    let cliList = doc.getIn(["tools", "cli"]);
    if (cliList && typeof cliList.add === "function") {
      cliList.add(entry);
    } else {
      doc.setIn(["tools", "cli"], [entry]);
    }
    // Small jitter so the two workers serialise rather than race-completing.
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(
      manifestPath,
      doc.toString({ flowCollectionPadding: false, lineWidth: 0 }),
    );
  } finally {
    await release();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
