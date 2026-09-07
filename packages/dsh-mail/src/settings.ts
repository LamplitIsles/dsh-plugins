import z from "@deepseek-ai/schemastery";
import {
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  GUION_MCP_ENDPOINT,
  OAUTH_REDIRECT_URI,
  type MailSettings
} from "./constants.js";
import { resolveMailConfig } from "./config.js";

export const MailSettingsSchema: z<MailSettings> = z.object({
  mailboxAddress: z.string().default(""),
  upstreamEndpoint: z.string().default(GUION_MCP_ENDPOINT),
  oauthAuthorizationServer: z.string().default(DEFAULT_OAUTH_AUTHORIZATION_SERVER),
  oauthCallbackUrl: z.string().default(OAUTH_REDIRECT_URI)
});

export function validateMailboxSetting(value: MailSettings): void {
  if (value.mailboxAddress.trim() !== "") normalizeMailboxAddress(value.mailboxAddress);
  resolveMailConfig(value);
}

export function normalizeMailboxAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("dsh-mail mailboxAddress is required.");
  const address = value.trim();
  if (!address || address.length > 320 || /[\r\n\0]/.test(address)) {
    throw new Error("dsh-mail mailboxAddress must be a valid email address.");
  }
  // The upstream identity is an email address, not a display-name or URL.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error("dsh-mail mailboxAddress must be a valid email address.");
  }
  return address.toLowerCase();
}
