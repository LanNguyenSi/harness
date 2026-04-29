// Worker process for tests/io/lock.test.ts. Run via child_process.fork.
// Acquires the lock, appends "<label>:lock-acquired", sleeps holdMs, appends
// "<label>:lock-released", releases. Uses proper-lockfile directly with the
// same options as src/io/lock.ts so the test does not depend on the TS build.
const fs = require("node:fs");
const lockfile = require("proper-lockfile");

const args = JSON.parse(process.argv[2]);
const { lockPath, dataPath, label, holdMs } = args;

if (!fs.existsSync(lockPath)) {
  fs.writeFileSync(lockPath, "");
}

(async () => {
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
    realpath: false,
  });
  try {
    fs.appendFileSync(dataPath, `${label}:lock-acquired\n`);
    await new Promise((r) => setTimeout(r, holdMs));
    fs.appendFileSync(dataPath, `${label}:lock-released\n`);
  } finally {
    await release();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
