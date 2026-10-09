// Location of the approval-signing key under `harness.generated/`.
//
// The key file `<generatedDir>/.approval-signing.key` is the secret
// grounding-mcp signs solution verdicts with. Harness no longer creates,
// rotates or reads it: grounding-mcp creates it itself at the path
// `generate-settings.ts` projects as `SOLUTION_VERDICT_SIGNING_KEY`
// (`signingKeyPathFor`). `harness uninstall` still removes the whole
// `generatedDir`, key included.

import * as crypto from "node:crypto";
import * as path from "node:path";

/** Basename of the signing-key file, a sibling of the other state under `generatedDir`. */
export const SIGNING_KEY_BASENAME = ".approval-signing.key";

/** Filesystem path of the signing key for a given `generatedDir`. */
export function signingKeyPathFor(generatedDir: string): string {
  return path.join(generatedDir, SIGNING_KEY_BASENAME);
}

/** sha256 hex digest of a string. */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
