"use strict";
// Test-only preload for the pipe-drain child tests. Loaded with `node
// --require` ahead of the CLI, it queues a large write on stdout before the
// CLI runs, the way a verb with a lot of output does: the part that does not
// fit the pipe buffer is still queued when the CLI decides to exit. It
// changes nothing else. The size comes from HARNESS_TEST_QUEUED_STDOUT_BYTES;
// without it the preload does nothing.

const bytes = Number(process.env["HARNESS_TEST_QUEUED_STDOUT_BYTES"] ?? 0);
if (Number.isInteger(bytes) && bytes > 0) {
  process.stdout.write("Q".repeat(bytes));
}
