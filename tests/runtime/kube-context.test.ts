import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKubeContext } from "../../src/runtime/kube-context.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeKubeconfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-kube-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const FULL = `apiVersion: v1
kind: Config
current-context: customer-prod
contexts:
  - name: customer-prod
    context:
      cluster: prod-cluster
      namespace: prod
  - name: dev-local
    context:
      cluster: minikube
      namespace: default
`;

describe("resolveKubeContext", () => {
  it("reads the current context and its namespace", () => {
    const r = resolveKubeContext({ kubeconfigPath: writeKubeconfig(FULL) });
    expect(r).toEqual({ context: "customer-prod", namespace: "prod" });
  });

  it("returns an empty namespace when the context declares none", () => {
    const cfg = `current-context: ctx-a
contexts:
  - name: ctx-a
    context:
      cluster: c
`;
    const r = resolveKubeContext({ kubeconfigPath: writeKubeconfig(cfg) });
    expect(r).toEqual({ context: "ctx-a", namespace: "" });
  });

  it("returns empty strings when the file is absent", () => {
    expect(resolveKubeContext({ kubeconfigPath: "/nonexistent/kube/config" })).toEqual(
      { context: "", namespace: "" },
    );
  });

  it("returns empty strings when the YAML is malformed", () => {
    const r = resolveKubeContext({
      kubeconfigPath: writeKubeconfig(": : not yaml\n  : :"),
    });
    expect(r).toEqual({ context: "", namespace: "" });
  });

  it("returns empty strings when no current-context is set", () => {
    const r = resolveKubeContext({
      kubeconfigPath: writeKubeconfig("contexts: []\n"),
    });
    expect(r).toEqual({ context: "", namespace: "" });
  });

  it("resolves an empty namespace when current-context names no matching entry", () => {
    const cfg = `current-context: ghost
contexts:
  - name: real
    context:
      namespace: ns
`;
    const r = resolveKubeContext({ kubeconfigPath: writeKubeconfig(cfg) });
    expect(r).toEqual({ context: "ghost", namespace: "" });
  });
});
