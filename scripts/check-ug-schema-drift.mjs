#!/usr/bin/env node
// Drift-guard for the Understanding-Report section list mirrored from
// `@lannguyensi/understanding-gate`'s parser (see task agent-tasks/a3d329e2,
// follow-up to PR #152).
//
// Harness hard-codes `UNDERSTANDING_REPORT_REQUIRED_SECTIONS` in
// src/cli/pack/understanding-report-schema-hint.ts to render the gate
// block message. The canonical list lives in the standalone parser's
// SECTIONS array. This script fetches the latest published version of
// the standalone package, extracts its SECTIONS keys, and compares
// against the local mirror. CI fails (exit 1) on drift; matching lists
// exit 0 silently except for a confirmation line.
//
// Implementation:
//   1. `npm pack @lannguyensi/understanding-gate@latest` into a tmp dir
//      (the dist-published tarball, no auth needed for public packages).
//   2. Extract, read dist/core/parser.js, regex-extract `key: "..."`
//      entries from the SECTIONS array.
//   3. Read the harness mirror via dynamic import of the compiled
//      `dist/cli/pack/understanding-report-schema-hint.js`.
//   4. Compare by length + ordered keys (the mirror uses friendly
//      labels like "Current Understanding (paragraph)"; the upstream
//      uses camelCase keys, so we normalize the mirror's leading-name
//      slice to camelCase before comparing).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const UPSTREAM_PKG = "@lannguyensi/understanding-gate";
const PARSER_RELPATH = "package/dist/core/parser.js";
const HARNESS_HINT_MODULE_RELPATH = "dist/cli/pack/understanding-report-schema-hint.js";

/** Convert a hint label like "Current Understanding (paragraph)" to "currentUnderstanding". */
export function labelToCamelKey(label) {
  const stripped = label.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = stripped.split(/\s+/);
  return parts
    .map((part, idx) =>
      idx === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

export function extractUpstreamSectionKeys(parserSource) {
  // Scope to the `const SECTIONS = [...];` slice; other places in
  // parser.js (e.g. the fast_confirm bullet-prefix table) also carry
  // `key: "..."` entries and would otherwise drift the count.
  const start = parserSource.search(/const\s+SECTIONS\s*=\s*\[/);
  if (start === -1) {
    throw new Error("parser.js layout changed: no `const SECTIONS = [` declaration found");
  }
  // Walk brackets from the start of the array literal until the matching
  // `]`. Bracket-balance (not a regex) since SECTIONS entries can contain
  // nested arrays (`aliases: [...]`). String-aware so brackets inside a
  // string literal (`aliases: ["foo ] bar"`) don't truncate the slice
  // and produce false-positive drift. Honors `\` escapes inside strings.
  const openIdx = parserSource.indexOf("[", start);
  let depth = 0;
  let endIdx = -1;
  let inString = null; // null | '"' | "'" | "`"
  let escape = false;
  for (let i = openIdx; i < parserSource.length; i++) {
    const ch = parserSource[i];
    if (inString !== null) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error("parser.js layout changed: SECTIONS array not closed");
  }
  const slice = parserSource.slice(openIdx, endIdx + 1);
  const keys = [];
  const re = /key:\s*"([a-zA-Z0-9_]+)"/g;
  let m;
  while ((m = re.exec(slice)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

function fetchUpstreamParserSource() {
  const dir = mkdtempSync(join(tmpdir(), "ug-drift-"));
  try {
    // `npm pack` downloads + emits the tarball into the cwd it runs in.
    execFileSync("npm", ["pack", `${UPSTREAM_PKG}@latest`, "--silent"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error(`no .tgz appeared in ${dir} after npm pack`);
    execFileSync("tar", ["-xzf", tarball], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const parserPath = join(dir, PARSER_RELPATH);
    return readFileSync(parserPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function loadHarnessMirror() {
  // The hint module is shipped as the compiled .js. We import it
  // dynamically so this script does not depend on a TypeScript step.
  // Precheck file existence first: a missing dist file is the common
  // "operator forgot to build" case, and the generic Node import error
  // ("Cannot find module ...") buries the actionable next step.
  const modulePath = join(process.cwd(), HARNESS_HINT_MODULE_RELPATH);
  if (!existsSync(modulePath)) {
    throw new Error(
      `harness mirror not found at ${modulePath}; run \`npm run build\` first to emit ${HARNESS_HINT_MODULE_RELPATH}.`,
    );
  }
  const moduleUrl = pathToFileURL(modulePath).href;
  const mod = await import(moduleUrl);
  if (!Array.isArray(mod.UNDERSTANDING_REPORT_REQUIRED_SECTIONS)) {
    throw new Error(
      `expected UNDERSTANDING_REPORT_REQUIRED_SECTIONS export from ${HARNESS_HINT_MODULE_RELPATH}; ` +
        `got ${typeof mod.UNDERSTANDING_REPORT_REQUIRED_SECTIONS}. Did you run \`npm run build\`?`,
    );
  }
  return mod.UNDERSTANDING_REPORT_REQUIRED_SECTIONS.map(labelToCamelKey);
}

export function diffKeys(localKeys, upstreamKeys) {
  if (localKeys.length === upstreamKeys.length && localKeys.every((k, i) => k === upstreamKeys[i])) {
    return null;
  }
  const localSet = new Set(localKeys);
  const upstreamSet = new Set(upstreamKeys);
  const onlyLocal = localKeys.filter((k) => !upstreamSet.has(k));
  const onlyUpstream = upstreamKeys.filter((k) => !localSet.has(k));
  // Order mismatch when sets are equal but sequence differs.
  const orderMismatch = onlyLocal.length === 0 && onlyUpstream.length === 0;
  return { onlyLocal, onlyUpstream, orderMismatch };
}

async function main() {
  const upstreamSource = fetchUpstreamParserSource();
  const upstreamKeys = extractUpstreamSectionKeys(upstreamSource);
  if (upstreamKeys.length === 0) {
    console.error(
      `drift-guard: extracted zero section keys from ${UPSTREAM_PKG}'s parser.js. ` +
        `Either the upstream layout changed (extract regex needs updating) or the tarball was empty.`,
    );
    process.exit(2);
  }
  const localKeys = await loadHarnessMirror();
  const diff = diffKeys(localKeys, upstreamKeys);
  if (diff === null) {
    console.log(
      `ug-schema-drift: OK (${localKeys.length} sections match ${UPSTREAM_PKG}@latest in order: ${localKeys.join(", ")})`,
    );
    process.exit(0);
  }
  console.error("ug-schema-drift: DRIFT DETECTED");
  console.error(`  upstream (${UPSTREAM_PKG}@latest): ${upstreamKeys.join(", ")}`);
  console.error(`  local (UNDERSTANDING_REPORT_REQUIRED_SECTIONS): ${localKeys.join(", ")}`);
  if (diff.orderMismatch) {
    console.error(`  cause: same sections, different order.`);
  } else {
    if (diff.onlyUpstream.length > 0) {
      console.error(`  missing locally (upstream added): ${diff.onlyUpstream.join(", ")}`);
    }
    if (diff.onlyLocal.length > 0) {
      console.error(`  extra locally (upstream removed): ${diff.onlyLocal.join(", ")}`);
    }
  }
  console.error(
    `  fix: update UNDERSTANDING_REPORT_REQUIRED_SECTIONS in src/cli/pack/understanding-report-schema-hint.ts to match.`,
  );
  process.exit(1);
}

// Only auto-run when invoked directly (not when imported by tests).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`ug-schema-drift: script failed: ${err.message}`);
    process.exit(2);
  });
}
