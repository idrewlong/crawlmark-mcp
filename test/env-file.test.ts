import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { formatEnvValue, parseEnvText, readEnvFile, setEnvValues, writeEnvFile } from "../src/lib/env-file.js";
import { POSIX_MODES } from "./platform.js";

const SAMPLE = `# DataForSEO
DATAFORSEO_LOGIN=old@example.com
DATAFORSEO_PASSWORD=old   # inline comment

# Google
export GOOGLE_AUTH_MODE=
PSI_API_KEY=
`;

describe("setEnvValues", () => {
  it("updates keys in place, keeps comments, blank lines and order, and appends new keys", () => {
    const r = setEnvValues(SAMPLE, { DATAFORSEO_LOGIN: "new@example.com", GOOGLE_AUTH_MODE: "oauth", NEW_KEY: "x" });
    expect(r.text).toBe(`# DataForSEO
DATAFORSEO_LOGIN=new@example.com
DATAFORSEO_PASSWORD=old   # inline comment

# Google
export GOOGLE_AUTH_MODE=oauth
PSI_API_KEY=
NEW_KEY=x
`);
    expect(r.updated.sort()).toEqual(["DATAFORSEO_LOGIN", "GOOGLE_AUTH_MODE"]);
    expect(r.added).toEqual(["NEW_KEY"]);
  });

  it("never duplicates a key: re-applying is a no-op, and a key already listed twice gets the value on both lines", () => {
    const once = setEnvValues(SAMPLE, { PSI_API_KEY: "k1" }).text;
    const twice = setEnvValues(once, { PSI_API_KEY: "k1" });
    expect(twice.text).toBe(once);
    expect(twice.updated).toEqual([]);
    expect(once.match(/PSI_API_KEY=/g)).toHaveLength(1);
    const dup = setEnvValues("A=1\nB=2\nA=3\n", { A: "9" }).text;
    expect(dup).toBe("A=9\nB=2\nA=9\n");
  });

  it("does not treat a commented-out key as set", () => {
    expect(setEnvValues("# PSI_API_KEY=abc\n", { PSI_API_KEY: "k" }).text).toBe("# PSI_API_KEY=abc\nPSI_API_KEY=k\n");
  });

  it("handles an empty file, a missing trailing newline and CRLF files", () => {
    expect(setEnvValues("", { A: "1" }).text).toBe("A=1\n");
    expect(setEnvValues("A=1", { B: "2" }).text).toBe("A=1\nB=2\n");
    expect(setEnvValues("A=1\r\nB=2\r\n", { B: "3" }).text).toBe("A=1\r\nB=3\r\n");
  });

  it("quotes values so Node's parser reads them back unchanged", () => {
    for (const v of ["plain", "with space", "has#hash", "it's", `q"uote`, "p@ss/w0rd+=", "a'b\"c"]) {
      const text = setEnvValues("", { K: v }).text;
      expect(parseEnv(text).K, v).toBe(v);
      expect(parseEnvText(text).K, v).toBe(v);
    }
    expect(() => formatEnvValue("a\nb")).toThrow(/line breaks/);
    // U+2028/U+2029 aren't line breaks in a .env file, but `.` doesn't match them in a JS regex.
    const sep = "a\u2028b\u2029c";
    expect(parseEnvText(setEnvValues("", { K: sep }).text).K).toBe(sep);
    expect(setEnvValues(setEnvValues("", { K: sep }).text, { K: "new" }).text).toBe("K=new\n");
    expect(() => setEnvValues("", { "BAD-KEY": "x" })).toThrow(/Invalid env key/);
  });
});

describe("writeEnvFile", () => {
  it("writes atomically with mode 0600, creating the file and its directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-envfile-"));
    const path = join(dir, "home", ".env");
    writeEnvFile(path, { DATAFORSEO_LOGIN: "a@example.com" });
    if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, SAMPLE);
    chmodSync(path, 0o644);
    writeEnvFile(path, { DATAFORSEO_PASSWORD: "secret value" });
    if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("# DataForSEO\n");
    expect(readEnvFile(path).DATAFORSEO_PASSWORD).toBe("secret value");
    expect(readdirSync(join(dir, "home")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("follows a symlinked .env so the link survives", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-envfile-"));
    writeFileSync(join(dir, "real.env"), "A=1\n");
    symlinkSync(join(dir, "real.env"), join(dir, ".env"));
    writeEnvFile(join(dir, ".env"), { B: "2" });
    expect(readFileSync(join(dir, "real.env"), "utf8")).toBe("A=1\nB=2\n");
  });
});
