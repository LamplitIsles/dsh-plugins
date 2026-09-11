export interface SessionPage {
  readonly records?: readonly {
    readonly event?: { readonly type?: string } | undefined;
  }[];
}

export function waitForFinalizedAssistant(options: {
  readonly loadPage: () => Promise<SessionPage>;
  readonly expectedText: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<unknown>;
  readonly now?: () => number;
}): Promise<SessionPage>;
