// One walker for the chain of symlinks a gate path leads through, shared by the
// Claude and the Codex gate. A snapshot or an installer backup sits beside the
// spelling the gate was run through, which may be any hop of the chain or its
// target, so both gates have to find the same hops from the same path.

import * as fs from "node:fs";
import * as path from "node:path";

/** More hops than any real dotfiles setup, so a loop ends quickly. */
const MAX_HOPS = 40;

/** Why a link chain stops where it does. */
export type LinkChainEnd =
  /** The last path exists and is not a symlink. */
  | "target"
  /** The last path does not exist: a symlink leads to a file that is gone, or the path itself is absent. */
  | "dangling"
  /** The hop budget ran out while every hop was still a symlink. */
  | "loop"
  /** A hop could not be read (no permission, a directory that vanished). */
  | "unreadable";

export interface LinkChain {
  /**
   * The path itself, then each path its symlink text leads to, ending at the
   * first path that is not a symlink or at the point where the chain cannot
   * be walked.
   */
  chain: string[];
  end: LinkChainEnd;
}

/**
 * The text of a symlink resolved the way the kernel does: against the
 * physical directory that holds the link, and, when the text climbs out of a
 * directory it entered (`d/../f`), through that directory's real location. A
 * lexical `path.dirname` of the link would be wrong whenever a directory on
 * the way to the link is itself a symlink: `..` then means the parent of the
 * directory it points to, not of the one it was reached through. The native
 * `realpath` is used because the JavaScript one folds `..` away lexically
 * before it resolves anything.
 */
function hopTarget(link: string, text: string): string {
  const realDir = fs.realpathSync.native(path.dirname(link));
  const lexical = path.resolve(realDir, text);
  if (path.isAbsolute(text) || !climbsOutOfADirectory(text)) return lexical;
  try {
    const raw = `${realDir}${path.sep}${text}`;
    return path.join(fs.realpathSync.native(path.dirname(raw)), path.basename(raw));
  } catch {
    return lexical;
  }
}

/** Whether a relative link text has a `..` that follows a directory name (`d/../f`), not just leading ones. */
function climbsOutOfADirectory(text: string): boolean {
  const segs = text.split("/");
  return segs.some((seg, i) => seg === ".." && i > 0 && segs[i - 1] !== ".." && segs[i - 1] !== "." && segs[i - 1] !== "");
}

/**
 * Walks the symlink chain of `start` one hop at a time. A relative link text
 * is resolved against the physical directory of the link holding it, so a
 * link reached through a directory symlink and written with `..` leads where
 * the kernel takes it.
 */
export function walkLinkChain(start: string): LinkChain {
  const chain = [start];
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let next: string;
    try {
      next = hopTarget(current, fs.readlinkSync(current));
    } catch (err) {
      // `readlink` answers EINVAL for anything that exists and is not a symlink.
      const code = (err as NodeJS.ErrnoException).code;
      return { chain, end: code === "EINVAL" ? "target" : code === "ENOENT" ? "dangling" : "unreadable" };
    }
    chain.push(next);
    current = next;
  }
  return { chain, end: "loop" };
}

/** The hops of `walkLinkChain`, for a caller that only looks beside each of them. */
export function linkChain(start: string): string[] {
  return walkLinkChain(start).chain;
}
