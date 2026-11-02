/**
 * Actionable "no access" errors for GA4 and Search Console: name the Google
 * identity crawlmark is using and where to grant it access. Pure; the provider
 * wrappers pass in the identity from googleAuthStatus().
 */
import { apiErrorInfo, classifyGtmError, type ApiErrorInfo, type GtmIdentity } from "./gtm.js";
import { cliHint } from "./cli-hint.js";

export type GoogleIdentity = GtmIdentity;

function describe(who: GoogleIdentity): { label: string; unknown: boolean } {
  if (who.mode === "service_account") return who.email ? { label: `${who.email} (service account)`, unknown: false } : { label: "the service account crawlmark uses", unknown: true };
  if (who.mode === "oauth") return who.email ? { label: `${who.email} (signed in with OAuth)`, unknown: false } : { label: "the Google account crawlmark is signed in with", unknown: true };
  return { label: "the Google account crawlmark uses", unknown: true };
}

function statusSuffix(info: ApiErrorInfo): string {
  return ` (Google: HTTP ${info.status ?? 403})`;
}

export function ga4AccessDeniedMessage(propertyId: string, who: GoogleIdentity, info: ApiErrorInfo = { status: 403, message: "", reasons: [] }): string {
  const { label, unknown } = describe(who);
  const prop = `GA4 property ${propertyId.replace(/^properties\//, "")}`;
  const fix =
    who.mode === "oauth"
      ? `Ask the property owner to add that account as a Viewer, or sign in with an account that has access: ${cliHint()} auth login.`
      : "In GA4, open Admin > Property access management > Add users, add that account's email with the Viewer role, then retry.";
  const lead = who.mode === "oauth" ? "isn't accessible to" : "isn't shared with";
  return `${prop} ${lead} ${label}. ${unknown ? `(crawlmark could not read the account's email; run ${cliHint()} auth status to see it.) ` : ""}${fix}${statusSuffix(info)}`;
}

export function gscAccessDeniedMessage(siteUrl: string, who: GoogleIdentity, info: ApiErrorInfo = { status: 403, message: "", reasons: [] }): string {
  const { label, unknown } = describe(who);
  const lead = who.mode === "oauth" ? "isn't accessible to" : "isn't shared with";
  const fix =
    who.mode === "oauth"
      ? `Ask a site owner to add that account in Search Console (Settings > Users and permissions), or sign in with an account that has access: ${cliHint()} auth login.`
      : "In Search Console, open Settings > Users and permissions > Add user, add that account's email with Restricted (or Full) permission, then retry.";
  return `Search Console property ${siteUrl} ${lead} ${label}. ${unknown ? `(crawlmark could not read the account's email; run ${cliHint()} auth status to see it.) ` : ""}${fix}${statusSuffix(info)}`;
}

/** True for a genuine permission failure (a 403 that is not a disabled API, quota or scope problem). */
function isPermissionDenied(info: ApiErrorInfo): boolean {
  return classifyGtmError(info) === "denied" && info.status === 403;
}

/** A 401: Google rejected the credentials themselves, which is not a sharing problem. */
function isUnauthenticated(info: ApiErrorInfo): boolean {
  return classifyGtmError(info) === "denied" && info.status === 401;
}

/** The credentials were rejected (revoked or expired), so granting access would not help. */
export function credentialsRejectedMessage(service: "GA4" | "Search Console", who: GoogleIdentity): string {
  const { label } = describe(who);
  const fix =
    who.mode === "oauth"
      ? `Sign in again: ${cliHint()} auth login.`
      : who.mode === "service_account"
        ? `The service-account key may have been revoked or deleted; download a new key and re-run ${cliHint()} setup --step google.`
        : `Check the Google setup: ${cliHint()} setup --step google.`;
  return `${service} rejected the credentials for ${label} (HTTP 401: invalid or expired). ${fix}`;
}

/** Rethrow a GA4 failure with an actionable message when it is a permission denial; other errors pass through unchanged. */
export function ga4Error(err: unknown, propertyId: string, who: GoogleIdentity): unknown {
  const info = apiErrorInfo(err);
  if (isUnauthenticated(info)) return new Error(credentialsRejectedMessage("GA4", who));
  return isPermissionDenied(info) ? new Error(ga4AccessDeniedMessage(propertyId, who, info)) : err;
}

export function gscError(err: unknown, siteUrl: string, who: GoogleIdentity): unknown {
  const info = apiErrorInfo(err);
  if (isUnauthenticated(info)) return new Error(credentialsRejectedMessage("Search Console", who));
  return isPermissionDenied(info) ? new Error(gscAccessDeniedMessage(siteUrl, who, info)) : err;
}
