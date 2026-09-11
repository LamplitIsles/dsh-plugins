import { english, type CompanionTranslate } from "./locale.js";
export function affinityStage(
  value: number,
  t: CompanionTranslate = english,
): string {
  const n = Math.max(0, Math.min(100, Math.trunc(value)));
  return n < 20
    ? t("affinity.distant")
    : n < 40
      ? t("affinity.unfamiliar")
      : n < 60
        ? t("affinity.familiar")
        : n < 80
          ? t("affinity.close")
          : t("affinity.deep");
}

export interface CompanionSessionCandidate {
  id: string;
  displayTitle?: string;
  updatedAt?: number;
  running?: boolean;
  archived?: boolean;
  origin?: string;
  parentId?: string;
  blank?: boolean;
}

export interface CompanionSessionListItem {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  selected: boolean;
}

/** Keep a manual selection stable while the authoritative list is reordered. */
export function resolveCompanionSessionSelection(
  workspaceId: string | undefined,
  explicit: { workspaceId: string; sessionId: string } | undefined,
  available: readonly CompanionSessionListItem[],
  entrySessionId: string | undefined,
): string | undefined {
  return workspaceId !== undefined &&
    explicit?.workspaceId === workspaceId &&
    available.some((item) => item.id === explicit.sessionId)
    ? explicit.sessionId
    : entrySessionId;
}

/** Project eligible sessions owned by the configured Workspace into sidebar rows. */
export function companionSessionList(
  sessions: readonly CompanionSessionCandidate[],
  selectedId: string | undefined,
  ownership: {
    sessionIds: readonly string[];
    archivedSessionIds: readonly string[];
  },
  t: CompanionTranslate = english,
): CompanionSessionListItem[] {
  const memberIds = new Set(ownership.sessionIds);
  const archivedIds = new Set(ownership.archivedSessionIds);
  return sessions
    .filter(
      (session) =>
        memberIds.has(session.id) &&
        !archivedIds.has(session.id) &&
        !session.archived &&
        session.origin !== "subagent",
    )
    .sort(
      (left, right) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .map((session) => ({
      id: session.id,
      title:
        session.displayTitle?.trim() ||
        (session.blank ? t("session.new") : t("session.untitled")),
      updatedAt: session.updatedAt ?? 0,
      running: Boolean(session.running),
      selected: session.id === selectedId,
    }));
}

/** Workspace.sessionIds is authoritative; list.current and cwd never decide Companion ownership. */
export function selectCompanionSession(
  sessions: readonly CompanionSessionCandidate[],
  ownership: {
    sessionIds: readonly string[];
    archivedSessionIds: readonly string[];
  },
): string | undefined {
  const memberIds = new Set(ownership.sessionIds);
  const archivedIds = new Set(ownership.archivedSessionIds);
  const members = sessions.filter(
    (session) =>
      memberIds.has(session.id) &&
      !archivedIds.has(session.id) &&
      !session.archived &&
      session.origin !== "subagent",
  );
  const recent = members
    .filter((session) => !session.blank)
    .sort(
      (left, right) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
        left.id.localeCompare(right.id),
    )[0];
  const blank = members
    .filter((session) => session.blank)
    .sort(
      (left, right) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
        left.id.localeCompare(right.id),
    )[0];
  return recent?.id ?? blank?.id;
}
