import { google } from "googleapis";
import { env } from "../config.js";

let auth: InstanceType<typeof google.auth.GoogleAuth> | undefined;

/** One service-account auth shared by GSC and GA4. */
export function googleAuth() {
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set. See .env.example.");
  }
  auth ??= new google.auth.GoogleAuth({
    keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly",
    ],
  });
  return auth;
}
