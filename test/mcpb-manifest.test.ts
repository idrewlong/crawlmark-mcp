import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The MCPB manifest spec, v0.3 (https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md):
// the fields Claude Desktop needs, checked strictly where we set them.
const userConfigOption = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const ManifestSchema = z.object({
  manifest_version: z.enum(["0.1", "0.2", "0.3"]),
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/),
  display_name: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().min(1),
  long_description: z.string().optional(),
  author: z.object({ name: z.string().min(1), email: z.string().optional(), url: z.string().url().optional() }),
  repository: z.object({ type: z.string(), url: z.string().url() }).optional(),
  server: z.object({
    type: z.enum(["node", "python", "binary"]),
    entry_point: z.string().min(1),
    mcp_config: z.object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  }),
  tools: z.array(z.object({ name: z.string().min(1), description: z.string().optional() })).optional(),
  prompts: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), arguments: z.array(z.string()).optional(), text: z.string().min(1) })).optional(),
  compatibility: z
    .object({
      claude_desktop: z.string().optional(),
      platforms: z.array(z.enum(["darwin", "win32", "linux"])).optional(),
      runtimes: z.object({ node: z.string().optional(), python: z.string().optional() }).optional(),
    })
    .optional(),
  user_config: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), userConfigOption).optional(),
});

function sourceNames(dir: string, re: RegExp): string[] {
  const names: string[] = [];
  for (const f of readdirSync(join(root, dir))) {
    if (!f.endsWith(".ts")) continue;
    for (const m of readFileSync(join(root, dir, f), "utf8").matchAll(re)) names.push(m[1]!);
  }
  return names.sort();
}

describe("mcpb/manifest.json", () => {
  it("matches the MCPB manifest schema", () => {
    const parsed = ManifestSchema.safeParse(manifest);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("starts the built server with node, from the extension directory", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("dist/index.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toContain("${__dirname}/dist/index.js");
  });

  it("has the same version as package.json and requires the same Node", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.compatibility.runtimes.node).toBe(">=22.13.0");
    expect(pkg.engines.node).toBe(">=22.13");
    expect(manifest.compatibility.platforms).toEqual(expect.arrayContaining(["darwin", "win32", "linux"]));
  });

  it("collects each credential as the right kind of field and maps it to an env var", () => {
    const uc = manifest.user_config;
    const env = manifest.server.mcp_config.env;
    expect(uc.dataforseo_login).toMatchObject({ type: "string" });
    expect(uc.dataforseo_password).toMatchObject({ type: "string", sensitive: true });
    expect(uc.dataforseo_live).toMatchObject({ type: "boolean", default: false });
    expect(uc.google_key_file).toMatchObject({ type: "file" });
    expect(uc.google_oauth_client_id).toMatchObject({ type: "string" });
    expect(uc.google_oauth_client_secret).toMatchObject({ type: "string", sensitive: true });
    expect(uc.psi_api_key).toMatchObject({ type: "string", sensitive: true });
    expect(uc.crux_api_key).toMatchObject({ type: "string", sensitive: true });
    expect(uc.bing_webmaster_api_key).toMatchObject({ type: "string", sensitive: true });
    expect(uc.chrome_path).toMatchObject({ type: "file" });
    expect(uc.crawlmark_home).toMatchObject({ type: "directory", default: "${HOME}/.crawlmark" });
    expect(env).toMatchObject({
      CRAWLMARK_HOME: "${user_config.crawlmark_home}",
      DATAFORSEO_LOGIN: "${user_config.dataforseo_login}",
      DATAFORSEO_PASSWORD: "${user_config.dataforseo_password}",
      DATAFORSEO_LIVE: "${user_config.dataforseo_live}",
      GOOGLE_APPLICATION_CREDENTIALS: "${user_config.google_key_file}",
      GOOGLE_OAUTH_CLIENT_ID: "${user_config.google_oauth_client_id}",
      GOOGLE_OAUTH_CLIENT_SECRET: "${user_config.google_oauth_client_secret}",
      PSI_API_KEY: "${user_config.psi_api_key}",
      CRUX_API_KEY: "${user_config.crux_api_key}",
      BING_WEBMASTER_API_KEY: "${user_config.bing_webmaster_api_key}",
      CHROME_PATH: "${user_config.chrome_path}",
    });
  });

  it("only references user_config keys it declares, uses each one, and requires none (everything is optional)", () => {
    const declared = Object.keys(manifest.user_config);
    const referenced = Object.values<string>(manifest.server.mcp_config.env).flatMap((v) => [...v.matchAll(/\$\{user_config\.([a-z0-9_]+)\}/g)].map((m) => m[1]!));
    expect(referenced.sort()).toEqual([...declared].sort());
    for (const key of declared) expect(manifest.user_config[key].required, key).not.toBe(true);
  });

  it("env names are ones the server reads (config.ts, browser.ts)", () => {
    const config = readFileSync(join(root, "src", "config.ts"), "utf8");
    const browser = readFileSync(join(root, "src", "providers", "browser.ts"), "utf8");
    for (const name of Object.keys(manifest.server.mcp_config.env)) {
      expect(config.includes(name) || browser.includes(name), name).toBe(true);
    }
  });

  it("lists exactly the tools and prompts the server registers", () => {
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(sourceNames("src/tools", /registerTool\(\s*"([a-z_0-9]+)"/g));
    expect(manifest.prompts.map((p: { name: string }) => p.name).sort()).toEqual(sourceNames("src/prompts", /registerPrompt\(\s*"([a-z0-9-]+)"/g));
  });

  it("does not carry secrets or a made-up author email", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|org|net)/i);
    expect(manifest.author.email).toBeUndefined();
  });
});

describe("package.json publish settings", () => {
  it("is publishable but guarded, with both bins and an allowlist that excludes source, tests and local data", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.scripts.prepublishOnly).toContain("prepublish-guard");
    expect(pkg.scripts.prepublishOnly).toContain("npm run build");
    expect(pkg.scripts.prepublishOnly).toContain("npm test");
    expect(pkg.bin).toEqual({ "crawlmark-mcp": "dist/index.js", "crawlmark-cli": "dist/cli.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "README.md", ".env.example", "config/clients.example.yaml", "!dist/**/*.map"]));
    for (const banned of ["src", "test", "data", "secrets", ".env", "config/clients.yaml", "config", "build"]) {
      expect(pkg.files.some((f: string) => f === banned || f === `${banned}/`), banned).toBe(false);
    }
  });
});
