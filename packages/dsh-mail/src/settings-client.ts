import type { MailSettings } from "./constants.js";

export function decodeSettings(value: unknown): Partial<MailSettings> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.mailboxAddress === "string"
      ? { mailboxAddress: record.mailboxAddress }
      : {}),
    ...(typeof record.upstreamEndpoint === "string"
      ? { upstreamEndpoint: record.upstreamEndpoint }
      : {}),
    ...(typeof record.oauthAuthorizationServer === "string"
      ? { oauthAuthorizationServer: record.oauthAuthorizationServer }
      : {}),
    ...(typeof record.oauthCallbackUrl === "string"
      ? { oauthCallbackUrl: record.oauthCallbackUrl }
      : {}),
  };
}
