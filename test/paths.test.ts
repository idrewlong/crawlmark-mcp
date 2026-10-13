import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { projectRoot, resolveFromRoot } from "../src/lib/paths.js";

describe("paths", () => {
  it("derives the project root from a module in src/ or dist/", () => {
    expect(projectRoot(pathToFileURL("/opt/app/src/config.ts").href)).toBe("/opt/app");
    expect(projectRoot(pathToFileURL("/opt/app/dist/config.js").href)).toBe("/opt/app");
  });

  it("resolves relative paths against the root", () => {
    expect(resolveFromRoot("/opt/app", "./config/clients.yaml")).toBe("/opt/app/config/clients.yaml");
    expect(resolveFromRoot("/opt/app", "data")).toBe("/opt/app/data");
    expect(resolveFromRoot("/opt/app", "../shared/key.json")).toBe("/opt/shared/key.json");
  });

  it("passes absolute paths through unchanged", () => {
    expect(resolveFromRoot("/opt/app", "/var/data")).toBe("/var/data");
  });
});
