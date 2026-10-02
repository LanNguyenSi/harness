"use strict";
// Test-only preload for the stdin-bound child tests (task 7dfdcaaf). It is
// loaded with `node --require` ahead of the CLI and writes one byte to fd 3
// the moment the CLI attaches its 'data' listener to process.stdin, which is
// the same synchronous block that arms the idle timer. The parent test starts
// its late-write clock from that byte, so the clock cannot start before the
// hook's timer does, however slow the runner is to boot node and load the CLI.
//
// It changes no behaviour of the CLI: it forwards every listener registration
// unchanged and only signals, and a missing fd 3 (the preload run without the
// extra pipe) is ignored.

const fs = require("node:fs");

const READY_FD = 3;
let signalled = false;

function signalOnce() {
  if (signalled) return;
  signalled = true;
  try {
    fs.writeSync(READY_FD, "r");
  } catch {
    // no readiness pipe: nothing to signal
  }
}

const stdin = process.stdin;
for (const name of ["on", "addListener"]) {
  const original = stdin[name];
  stdin[name] = function patched(event, ...rest) {
    const result = original.call(this, event, ...rest);
    if (event === "data") signalOnce();
    return result;
  };
}
