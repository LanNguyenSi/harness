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
  /** The last path does not exist: a symlink leads to a file that is gone, or to a directory that is gone, or the path itself is absent. */
  | "dangling"
  /** The hop budget ran out while every hop was still a symlink. */
  | "loop"
  /** A hop could not be read (no permission, a directory on the way that is a file). */
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

/** How a failed step of the walk ends the chain: nothing at the path, or a path that cannot be read. */
function endOf(err: unknown): "dangling" | "unreadable" {
  return (err as NodeJS.ErrnoException).code === "ENOENT" ? "dangling" : "unreadable";
}

/**
 * Walks the symlink chain of `start` one hop at a time, resolving each hop
 * the way the kernel does. A relative link text is appended, as written, to
 * the physical directory that holds the link (an absolute text is taken as
 * written), and everything but the last name of that path is then resolved by
 * the native `realpath`, which walks `..`, `.` and empty segments through the
 * real directories one step at a time. Nothing is folded lexically: `d/..` is
 * the parent of the directory `d` leads to, not the directory holding `d`,
 * whether the text is relative or absolute (the JavaScript `realpath` and
 * `path.resolve` fold `d/..` away before they look at `d`). The last name is
 * kept as written, since it may be the next link. When the directory part
 * leads nowhere (a directory on the way is gone), the chain ends dangling at
 * that path as the link wrote it, never at a lexical guess of where it might
 * have led.
 */
export function walkLinkChain(start: string): LinkChain {
  const chain = [start];
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let raw: string;
    try {
      const text = fs.readlinkSync(current);
      const linkDir = fs.realpathSync.native(path.dirname(current));
      // Appended as written: `path.join` would fold `d/..` before the kernel's walk below.
      raw = path.isAbsolute(text) ? text : `${linkDir}${path.sep}${text}`;
    } catch (err) {
      // `readlink` answers EINVAL for anything that exists and is not a symlink.
      return { chain, end: (err as NodeJS.ErrnoException).code === "EINVAL" ? "target" : endOf(err) };
    }
    let next: string;
    try {
      // The kernel's own lookup first: the native `realpath` of macOS walks
      // `file/..` back to the file's directory, where the kernel answers ENOTDIR.
      fs.statSync(path.dirname(raw));
      if (raw.endsWith(path.sep)) {
        // A trailing separator asks the kernel for a directory. `basename`
        // below would drop it and walk the same-named file as a target,
        // while the path as spelled answers ENOTDIR: stat the whole path so
        // that lands as an unreadable end, like any other unreadable link.
        fs.statSync(raw);
      }
      next = path.join(fs.realpathSync.native(path.dirname(raw)), path.basename(raw));
    } catch (err) {
      chain.push(raw);
      return { chain, end: endOf(err) };
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

/**
 * A path spelled with a `..` segment, replaced by its directory as the kernel
 * resolves it plus the same last name. Joining a name to a directory (and
 * `path.resolve`, `path.normalize`) folds `..` lexically, which leads
 * elsewhere when the name before it is a directory link (`via/..` is the
 * parent of where `via` leads, not the directory that holds `via`). `..` is
 * the only segment such a fold moves (`.` and empty segments fold to the same
 * directory), so every other spelling is kept as given. A directory that
 * cannot be resolved leaves the spelling as given: nothing can be read or
 * written through it.
 */
export function kernelEntry(spelled: string): string {
  if (!spelled.split(path.sep).includes("..")) return spelled;
  const dir = path.dirname(spelled);
  try {
    // The kernel's own lookup first: the native `realpath` of macOS walks `file/..` back to the file's directory.
    fs.statSync(dir);
    return path.join(fs.realpathSync.native(dir), path.basename(spelled));
  } catch {
    return spelled;
  }
}
