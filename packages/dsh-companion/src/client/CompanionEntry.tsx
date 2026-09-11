import type { ReactNode } from "react";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import css from "./CompanionEntry.module.css";

export type CompanionEntryProps = PropsRuntime<"shell.overlay"> &
  PropsLocale<"dsh-companion">;

/** Frame-wide stock-surface entry; navigation intentionally starts a fresh page. */
export function CompanionEntry({ t }: CompanionEntryProps): ReactNode {
  return (
    <div className={css.root}>
      <a
        className={css.button}
        href="/companion/"
        aria-label={t("companion.open")}
        data-testid="dsh-companion-entry"
      >
        <span className={css.mark} aria-hidden="true">
          ✦
        </span>
        <span>{t("companion.open")}</span>
      </a>
    </div>
  );
}
