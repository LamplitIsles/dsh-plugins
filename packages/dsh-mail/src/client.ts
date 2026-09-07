import type {} from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { registerMailSettingsCard, type MailClientContext } from "./client/settings-card.js";

/** Browser services consumed by the mailbox settings card. */
export const inject = ["slots", "connection", "settingsScope"] as const;

export function apply(ctx: MailClientContext): void {
  registerMailSettingsCard(ctx);
}

export default { inject, apply };
