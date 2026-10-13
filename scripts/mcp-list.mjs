#!/usr/bin/env node
// Start an MCP server over stdio and print its tool and prompt names as JSON.
// Dependency-free JSON-RPC, so it works against any install (repo, tarball install, unzipped bundle).
//
//   node scripts/mcp-list.mjs <command> [args...]
//   node scripts/mcp-list.mjs node /path/to/dist/index.js
//
// The server inherits this process's environment (set CRAWLMARK_HOME etc. before calling).
// MCP_LIST_CALL=<tool> also calls that tool (no arguments) and prints its text result under "call".
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: mcp-list.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(msg.id);
  if (waiter) {
    pending.delete(msg.id);
    msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-list", version: "0.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await request("tools/list");
  const prompts = await request("prompts/list");
  let call;
  if (process.env.MCP_LIST_CALL) {
    const r = await request("tools/call", { name: process.env.MCP_LIST_CALL, arguments: {} });
    call = r.content?.map((c) => c.text).join("\n");
  }
  console.log(
    JSON.stringify({
      server: init.serverInfo,
      tools: tools.tools.map((t) => t.name),
      prompts: prompts.prompts.map((p) => p.name),
      ...(call !== undefined ? { call } : {}),
    }),
  );
  child.stdin.end();
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(`mcp-list: ${err.message}`);
  child.kill();
  process.exit(1);
}
