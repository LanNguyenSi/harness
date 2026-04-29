#!/usr/bin/env node
import { run } from "./index.js";

run().then((code) => {
  process.exit(code);
});
