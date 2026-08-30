import * as fs from "node:fs";
import * as path from "node:path";
import { readRegularFileRejectingSymlink } from "./read-regular-file.js";
import { safeJsonParse } from "./safe-json-parse.js";

/**
 * Shared read-and-classify loop for a directory of small JSON marker/record
 * files, used by every doctor/observation reader that scans one file per
 * session and tolerates missing/corrupt entries rather than throwing
 * (extracted from `ug-auto-approvals.ts` and `permission-mode-observations.ts`,
 * which had the same 15-line loop verbatim: readdir, reject symlink /
 * non-regular / raced-away entries silently, count a read failure as
 * unreadable, `safeJsonParse` the body, hand it to the caller's own
 * validator/transform).
 *
 * A missing directory resolves to `{ dirPresent: false, entries: [],
 * unreadableCount: 0 }` rather than throwing: every caller here is a
 * best-effort read for a doctor listing or an audit surface, never a gate
 * decision.
 */
export interface ReadJsonDirEntriesResult<T> {
  dirPresent: boolean;
  entries: T[];
  unreadableCount: number;
}

export interface ReadJsonDirEntriesOptions<T> {
  /**
   * Return true to silently skip an entry (not counted as unreadable) before
   * it is even read. Used to exclude filenames that are not this reader's
   * kind of marker at all (a differently-prefixed sibling marker in the
   * same directory), as distinct from a marker that IS this reader's kind
   * but fails to parse.
   */
  skip?: (name: string) => boolean;
  /**
   * Parse and validate the file's already-`safeJsonParse`d body. Return the
   * value to keep, or null to count the entry as unreadable.
   */
  parse: (raw: unknown, name: string) => T | null;
}

export function readJsonDirEntriesRejectingSymlinks<T>(
  dir: string,
  opts: ReadJsonDirEntriesOptions<T>,
): ReadJsonDirEntriesResult<T> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dirPresent: false, entries: [], unreadableCount: 0 };
  }

  const entries: T[] = [];
  let unreadableCount = 0;

  for (const d of dirents) {
    const name = d.name;
    if (opts.skip?.(name)) continue;

    const full = path.join(dir, name);
    const read = readRegularFileRejectingSymlink(full);
    if (read.kind === "symlink" || read.kind === "not-regular" || read.kind === "missing") {
      continue;
    }
    if (read.kind === "unreadable") {
      unreadableCount++;
      continue;
    }
    const parsed = safeJsonParse(read.content);
    const value = opts.parse(parsed, name);
    if (value === null) {
      unreadableCount++;
      continue;
    }
    entries.push(value);
  }

  return { dirPresent: true, entries, unreadableCount };
}
