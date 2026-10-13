import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/setup/cli-setup.js";

describe("child process env", () => {
  const env = { PATH: "/bin", DATAFORSEO_PASSWORD: "from-dotenv", SHELL_VAR: "x", CRAWLMARK_HOME: "/stale" };
  const fromFile = new Set(["DATAFORSEO_PASSWORD"]);

  it("drops variables loaded from .env so the child re-reads the edited file", () => {
    const e = buildChildEnv(env, fromFile, { dir: "/h", source: "env" });
    expect(e.DATAFORSEO_PASSWORD).toBeUndefined();
    expect(e.SHELL_VAR).toBe("x");
    expect(e.PATH).toBe("/bin");
  });

  it("passes CRAWLMARK_HOME only when the home isn't the project root", () => {
    expect(buildChildEnv(env, fromFile, { dir: "/h", source: "env" }).CRAWLMARK_HOME).toBe("/h");
    expect(buildChildEnv(env, fromFile, { dir: "/u/.crawlmark", source: "user" }).CRAWLMARK_HOME).toBe("/u/.crawlmark");
    expect("CRAWLMARK_HOME" in buildChildEnv(env, fromFile, { dir: "/repo", source: "project" })).toBe(false);
  });
});
