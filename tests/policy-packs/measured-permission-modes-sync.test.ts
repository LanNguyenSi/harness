// Slice 2 AC 3 (docs/decisions/2026-08-27-ug-auto-mode-approval.md): keeps
// `src/policy-packs/builtin/understanding-before-execution/measured-permission-modes.ts`
// honest against the checked-in dogfood fixtures in THIS repo (`harness
// validate` itself runs in the operator's repo, which has no `dogfood/`
// directory, so this sync test is the only place that can bind the
// registry to real evidence).
//
// Two directions, both required:
//  1. every registry entry's fixture exists and actually carries the
//     claimed `permission_mode` value on a `PreToolUse` hook payload;
//  2. every `permission_mode` value found in any checked-in
//     `*.PreToolUse.json` fixture is registered for its harness (so a
//     fixture capturing a NEW literal fails this test until the registry
//     gains the entry).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEASURED_FIXTURES_DIR,
  MEASURED_PERMISSION_MODES,
  harnessForFixtureFile,
} from "../../src/policy-packs/builtin/understanding-before-execution/measured-permission-modes.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const PAYLOADS_DIR = path.join(REPO_ROOT, "dogfood", "ug-auto-mode-signals", "payloads");

interface PreToolUsePayload {
  hook_event_name?: unknown;
  permission_mode?: unknown;
}

function readPreToolUseEvents(absPath: string): PreToolUsePayload[] {
  const raw = JSON.parse(fs.readFileSync(absPath, "utf8"));
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  return items.filter(
    (item): item is PreToolUsePayload => typeof item === "object" && item !== null,
  );
}

describe("MEASURED_PERMISSION_MODES sync — registry -> fixture", () => {
  for (const entry of MEASURED_PERMISSION_MODES) {
    it(`${entry.harness}/${entry.permissionMode} fixture (${entry.fixture}) exists and matches`, () => {
      // The fixture must live in the payloads directory and its file name
      // must attribute it to the harness the entry claims: a Claude Code
      // fixture backing a Codex entry (or vice versa) is a registry error.
      expect(entry.fixture.startsWith(`${MEASURED_FIXTURES_DIR}/`)).toBe(true);
      expect(
        harnessForFixtureFile(path.basename(entry.fixture)),
        `${entry.fixture} is not a ${entry.harness} fixture by file name`,
      ).toBe(entry.harness);
      const absPath = path.join(REPO_ROOT, entry.fixture);
      expect(fs.existsSync(absPath), `missing fixture: ${entry.fixture}`).toBe(true);
      const events = readPreToolUseEvents(absPath);
      const preToolUseEvents = events.filter((e) => e.hook_event_name === "PreToolUse");
      expect(
        preToolUseEvents.length,
        `expected at least one PreToolUse event in ${entry.fixture}`,
      ).toBeGreaterThan(0);
      for (const event of preToolUseEvents) {
        expect(event.hook_event_name).toBe("PreToolUse");
        expect(event.permission_mode).toBe(entry.permissionMode);
      }
    });
  }
});

describe("MEASURED_PERMISSION_MODES sync — fixture -> registry", () => {
  const files = fs.readdirSync(PAYLOADS_DIR).filter((f) => f.endsWith(".PreToolUse.json"));

  it("found at least one *.PreToolUse.json fixture to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const basename of files) {
    it(`every permission_mode observed in ${basename} is registered for its harness`, () => {
      const harness = harnessForFixtureFile(basename);
      const absPath = path.join(PAYLOADS_DIR, basename);
      const events = readPreToolUseEvents(absPath).filter(
        (e) => e.hook_event_name === "PreToolUse",
      );
      expect(events.length, `expected at least one PreToolUse event in ${basename}`).toBeGreaterThan(
        0,
      );
      for (const event of events) {
        const mode = event.permission_mode;
        expect(typeof mode).toBe("string");
        const registered = MEASURED_PERMISSION_MODES.some(
          (entry) => entry.harness === harness && entry.permissionMode === mode,
        );
        expect(
          registered,
          `${basename} emits permission_mode "${String(mode)}" for harness "${harness}" ` +
            `but no registry entry claims it`,
        ).toBe(true);
      }
    });
  }
});
