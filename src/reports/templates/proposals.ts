/**
 * Confirmation tokens for template proposals (Phase 13 C, D18). create_report_template /
 * update_report_template without a token return a proposal and a token; the save call must bring the token
 * back with the same arguments. A token is `tpl_` + 26 base32 characters (130 random bits), lives 15 minutes
 * in the local cache, is used at most once, and is bound to the tool, the target file, the file's bytes when
 * proposed, the proposed bytes, the client and a hash of the arguments.
 */
import { createHash, randomBytes } from "node:crypto";
import { cacheKey, putCache } from "../../lib/cache.js";
import { db } from "../../lib/store.js";

export const PROPOSAL_TTL_SECONDS = 15 * 60;
export const TOKEN_RE = /^tpl_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ProposalBinding {
  tool: "create_report_template" | "update_report_template";
  path: string;
  /** SHA-256 of the file's bytes when proposed (null: it didn't exist). */
  beforeHash: string | null;
  afterHash: string;
  client: string | null;
  argsHash: string;
  /** The proposal has paid sections, so the save needs paidAcknowledged: true. */
  paid: boolean;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** Why a confirm call was refused. */
export class ProposalError extends Error {
  override name = "ProposalError";
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26 Crockford base32 characters from 17 random bytes (130 random bits; the spec asks for at least 128). */
export function newToken(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `tpl_${out}`;
}

/** Canonical JSON: object keys sorted at every level; undefined values dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
}

/** SHA-256 of the tool arguments without confirmToken and paidAcknowledged. */
export function argumentsHash(tool: string, args: Record<string, unknown>): string {
  const { confirmToken: _t, paidAcknowledged: _p, ...rest } = args;
  return createHash("sha256").update(canonicalJson({ tool, args: rest })).digest("hex");
}

const keyOf = (token: string) => cacheKey("tpl-proposal", token);

/** Store a proposal's binding under a fresh token for 15 minutes. */
export function createProposal(binding: Omit<ProposalBinding, "expiresAt">, now = Date.now()): { token: string; expiresAt: string } {
  const token = newToken();
  const expiresAt = Math.floor(now / 1000) + PROPOSAL_TTL_SECONDS;
  putCache(keyOf(token), PROPOSAL_TTL_SECONDS, { ...binding, expiresAt } satisfies ProposalBinding);
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

const getStmt = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?");
const deleteStmt = db.prepare("DELETE FROM cache WHERE key = ?");

/**
 * Check a confirm call against its proposal without using the token up: it must exist, be unexpired, belong
 * to this tool and have been made with the same arguments. Returns the binding.
 */
export function checkProposal(token: string, expect: { tool: ProposalBinding["tool"]; argsHash: string }): ProposalBinding {
  if (!TOKEN_RE.test(token)) throw new ProposalError("That confirmToken isn't one this server issued. Propose the template again (call without confirmToken).");
  const row = getStmt.get(keyOf(token)) as { value: string; expires_at: number } | undefined;
  if (!row) throw new ProposalError("Unknown or already used confirmToken. Propose the template again (call without confirmToken) and show the user the new draft.");
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    deleteStmt.run(keyOf(token));
    throw new ProposalError("The confirmToken expired (proposals last 15 minutes). Propose the template again and show the user the new draft.");
  }
  const b = JSON.parse(row.value) as ProposalBinding;
  if (b.tool !== expect.tool) throw new ProposalError(`That confirmToken is for ${b.tool}, not ${expect.tool}.`);
  if (b.argsHash !== expect.argsHash) {
    throw new ProposalError("The arguments differ from the proposal this token was issued for. Pass exactly the same arguments plus confirmToken, or propose the new version first and show it to the user.");
  }
  return b;
}

/**
 * Use the token up (single use). Returns false when another call already used it. Called once a save is
 * attempted: on success, on a changed file and on a declined elicitation alike.
 */
export function consumeProposal(token: string): boolean {
  return Number(deleteStmt.run(keyOf(token)).changes) > 0;
}
