// Hook-side pin of the leading-prefix environment resolution (task 65807a1b):
// `harness policy intercept` must block the production-scoped gate exactly for
// the fixtures that resolve to production (inline `VAR=value`, quoted values,
// several assignments, a later assignment overriding an earlier one,
// `cd <path> &&`, `git switch <branch> &&`). The corpus used to be checked
// through the removed debug verbs; this keeps the hook's own verdict pinned.

import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURES,
  hookBlocks,
  makeGitRepo,
  runParityCleanups,
  writeEvent,
} from "../_helpers/intercept-parity.js";

afterEach(runParityCleanups);

describe("policy intercept: leading-prefix environment corpus", () => {
  for (const fx of FIXTURES) {
    it(`${fx.expectedEnv === "production" ? "blocks" : "allows"}: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(fx.command({ prod }), cwd);

      expect(await hookBlocks(eventPath)).toBe(fx.expectedEnv === "production");
    });
  }
});
