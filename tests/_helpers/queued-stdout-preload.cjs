"use strict";
// Test-only preload for the pipe-drain child tests. Loaded with `node
// --require` ahead of the CLI, it queues a large write on stdout and/or
// stderr before the CLI runs, the way a verb with a lot of output does: the
// part that does not fit the pipe buffer is still queued when the CLI decides
// to exit. It changes nothing else. The sizes come from
// HARNESS_TEST_QUEUED_STDOUT_BYTES and HARNESS_TEST_QUEUED_STDERR_BYTES;
// a stream whose variable is unset gets nothing.

function queue(stream, name, fill) {
  const bytes = Number(process.env[name] ?? 0);
  if (Number.isInteger(bytes) && bytes > 0) stream.write(fill.repeat(bytes));
}

queue(process.stdout, "HARNESS_TEST_QUEUED_STDOUT_BYTES", "Q");
queue(process.stderr, "HARNESS_TEST_QUEUED_STDERR_BYTES", "E");
