/**
 * Reject sessionIds that would escape their intended namespace via path
 * traversal or directory separators. The value lands in a path.join verbatim;
 * an accidental `..` or `/` would otherwise reach a sibling directory. This is
 * defensive (session ids come from the Claude Code runtime, not direct user
 * input) but pins the trust boundary.
 */
export function rejectMalformedSessionId(sessionId: string): void {
  if (sessionId.trim().length === 0) {
    throw new Error("sessionId is empty or blank");
  }
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    throw new Error(
      `sessionId contains path-separator or traversal characters: ${JSON.stringify(sessionId)}`,
    );
  }
}
