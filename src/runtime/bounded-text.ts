/**
 * Cap on the agent-facing text of one block, in UTF-8 bytes. A hook's output
 * travels through a pipe the host reads at its own pace, and a block reason
 * can embed text of unbounded size (a manifest parse error grows with the
 * manifest), so every reason is cut to this size before it is written.
 */
export const BLOCK_TEXT_MAX_BYTES = 4096;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes, followed by a marker that
 * names how many bytes were dropped. A text that fits is returned unchanged.
 * The cut never lands inside a multi-byte character: it backs up to the
 * start of the character that straddles the limit, so the kept prefix is
 * valid UTF-8 and the dropped count is exact.
 */
export function boundUtf8(text: string, maxBytes: number = BLOCK_TEXT_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let cut = Math.max(0, maxBytes);
  // 0b10xxxxxx marks a continuation byte; stop at the lead byte of the
  // character the limit falls into and drop that whole character.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  const kept = bytes.subarray(0, cut).toString("utf8");
  return `${kept}\n[truncated ${bytes.length - cut} bytes]`;
}
