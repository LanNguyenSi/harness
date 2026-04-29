import * as fs from "node:fs";
import * as path from "node:path";
import { Document, parseDocument } from "yaml";

export interface AtomicWriteOptions {
  mode?: number;
}

export function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmpPath, "w", options.mode ?? 0o644);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function withDocument(
  yamlString: string,
  mutate: (doc: Document.Parsed) => void,
): string {
  const doc = parseDocument(yamlString);
  mutate(doc);
  // flowCollectionPadding:false matches our manifest style ([a, b], not [ a, b ]).
  // lineWidth:0 disables 80-col folding so long flow-sequences (e.g. an
  // mcp[].command path > 80 chars) are not silently rewritten to block style.
  // Together these make a no-op round-trip on a manifest authored in our
  // convention byte-equivalent.
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export { parseDocument };
export type { Document };
