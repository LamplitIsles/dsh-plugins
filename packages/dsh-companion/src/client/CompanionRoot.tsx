import { english, type CompanionTranslate } from "./locale.js";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { mount, unmount } from "svelte";
import { writable, type Writable } from "svelte/store";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  ISession,
  SessionListState,
  SessionSnapshot,
  PendingSubmissionRetirement,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  ClientConnectionRpc,
  ConnectionHandle,
} from "@deepseek-ai/dsh-client-connection/client";
import CompanionBridge from "./CompanionBridge.svelte";
import type {
  CompanionBridgeProps,
  CompanionHistoryView,
} from "./companion-bridge.js";
import {
  affinityStage,
  companionSessionList,
  resolveCompanionSessionSelection,
  selectCompanionSession,
} from "./relationship.js";
import { projectConversation } from "../projection.js";
import { TtsPreparationCache } from "./voice-cache.js";
import {
  CompanionPreControllerError,
  submitCompanionInput,
} from "./admission.js";
import { companionSessionOpenPlan } from "./session-opening.js";
import type { ClientSettings } from "./settings.js";
import {
  RPC_CHANNEL as TTS_CHANNEL,
  RPC_ENDPOINT as TTS_ENDPOINT,
} from "./tts-contract.js";
import {
  CONTINUITY_VIEW_TARGET,
  type CompanionContinuitySnapshot,
  type ContextPressureProjection,
} from "../continuity.js";
import type { ImageAttachmentLimits } from "@deepseek-ai/dsh-attachment";
import type { CompanionImageDraft } from "./image-drafts.js";
import {
  resolveSessionReadiness,
  resolveWorkspaceReadiness,
  type CompanionReadiness,
} from "./readiness.js";
import type { Mood } from "../domain.js";
import { SubmissionHandoff } from "./submission-handoff.js";
import {
  normalizeVoiceTranscription,
  voiceBlobToBase64,
  type VoiceRecording,
  type CompanionVoiceTranscription,
} from "./voice-input.js";
import {
  VOICE_CAPABILITY_ENDPOINT,
  VOICE_TRANSCRIBE_ENDPOINT,
} from "../voice-contract.js";

export interface CompanionRootInjected {
  t?: CompanionTranslate;
  ctx: ClientContext;
  settings: SettingsScope<ClientSettings>;
}

interface RelationshipView {
  sourceWorkspaceId?: string;
  identity?: ClientSettings;
  state?: { mood: string; note?: string; affinity: number; signature: string };
  workspacePresent: boolean;
  revision: number;
}

const NEUTRAL_RELATIONSHIP: RelationshipView = {
  workspacePresent: false,
  revision: 0,
};
const LOADING_HISTORY: CompanionHistoryView = {
  status: "loading",
  records: [],
  hasEarlier: false,
};

function historyPageFrom(
  value: unknown,
): Omit<CompanionHistoryView, "status" | "loadingEarlier"> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("history-invalid");
  const page = value as {
    records?: unknown;
    hasEarlier?: unknown;
    nextBefore?: unknown;
    predecessor?: unknown;
  };
  if (!Array.isArray(page.records) || typeof page.hasEarlier !== "boolean")
    throw new Error("history-invalid");
  if (
    page.nextBefore !== undefined &&
    (typeof page.nextBefore !== "number" ||
      !Number.isSafeInteger(page.nextBefore) ||
      page.nextBefore < 0)
  )
    throw new Error("history-invalid");
  return {
    records: page.records as CompanionHistoryView["records"],
    hasEarlier: page.hasEarlier,
    ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
    ...(page.predecessor === undefined
      ? {}
      : {
          predecessor: page.predecessor as CompanionHistoryView["predecessor"],
        }),
  };
}

function useSnapshot<T>(
  source:
    | { getSnapshot(): T; subscribe(listener: () => void): () => void }
    | undefined,
  fallback: T,
): T {
  const subscribe = source?.subscribe?.bind(source) ?? (() => () => undefined);
  const getSnapshot = source?.getSnapshot?.bind(source) ?? (() => fallback);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function workspaceFor(
  settings: ClientSettings | undefined,
  workspaceState: WorkspaceSnapshot,
): { id: string; sessionIds: readonly string[] } | undefined {
  if (!settings?.workspaceId) return undefined;
  const item = workspaceState.items.find(
    (candidate) => candidate.workspaceId === settings.workspaceId,
  );
  if (!item) return undefined;
  return { id: item.workspaceId, sessionIds: item.sessionIds };
}

function imageUrl(session: ISession, attachment: unknown): Promise<string> {
  const id =
    typeof attachment === "object" && attachment !== null
      ? (attachment as { attachmentId?: unknown }).attachmentId
      : undefined;
  if (typeof id !== "string")
    return Promise.reject(new Error("attachment-invalid"));
  return session.readAttachment(id as never).then((result) => {
    if (!result.ok) throw new Error(result.error.message);
    const type = result.value.attachment.mediaType || "image/png";
    return URL.createObjectURL(
      new Blob([new Uint8Array(result.value.data).buffer as ArrayBuffer], {
        type,
      }),
    );
  });
}

export function CompanionRoot({
  ctx,
  settings,
  t = english,
}: CompanionRootInjected): JSX.Element {
  const list = useSnapshot<SessionListState>(ctx.sessions.list, {
    ids: [],
    byId: {},
    current: undefined,
    phase: "pending",
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  });
  const workspaceList = useSnapshot<WorkspaceSnapshot>(ctx.workspaces.list, {
    items: [],
    archivedSessionIds: [],
    state: "loading",
    phase: "pending",
    error: null,
  });
  const connection = (ctx as unknown as { connection: ConnectionHandle })
    .connection;
  const connectionState = useSnapshot(connection.state, undefined);
  const settingsSubscribe = useMemo(
    () => settings.subscribe.bind(settings),
    [settings],
  );
  const settingsGetSnapshot = useMemo(
    () => settings.getSnapshot.bind(settings),
    [settings],
  );
  const settingsSnapshot = useSyncExternalStore(
    settingsSubscribe,
    settingsGetSnapshot,
    settingsGetSnapshot,
  );
  const configured = settingsSnapshot.value;
  const workspace = workspaceFor(configured, workspaceList);
  const workspaceReadiness: CompanionReadiness =
    settingsSnapshot.status === "loading"
      ? "loading"
      : settingsSnapshot.status === "unavailable"
        ? "error"
        : resolveWorkspaceReadiness(configured?.workspaceId, workspaceList);
  const workspaceRows = useMemo(() => {
    if (!workspace) return [];
    const rows = list.byId as Record<
      string,
      (typeof list.byId)[keyof typeof list.byId] | undefined
    >;
    return workspace.sessionIds
      .map((id) => rows[id])
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }, [list.byId, workspace]);
  const availableSessions = useMemo(
    () =>
      workspace
        ? companionSessionList(
            workspaceRows,
            undefined,
            {
              sessionIds: workspace.sessionIds,
              archivedSessionIds: workspaceList.archivedSessionIds,
            },
            t,
          )
        : [],
    [workspace, workspaceList.archivedSessionIds, workspaceRows, t],
  );
  const entryCandidate = useMemo(
    () =>
      workspace && workspaceList.phase === "ready" && list.phase === "ready"
        ? selectCompanionSession(workspaceRows, {
            sessionIds: workspace.sessionIds,
            archivedSessionIds: workspaceList.archivedSessionIds,
          })
        : undefined,
    [
      list.phase,
      workspace,
      workspaceList.archivedSessionIds,
      workspaceList.phase,
      workspaceRows,
    ],
  );
  const entryWorkspaceId = workspace?.id;
  const [selected, setSelected] = useState<{
    workspaceId: string;
    sessionId: string;
  }>();
  const [entrySelection, setEntrySelection] = useState<{
    workspaceId: string;
    sessionId?: string;
  }>();
  useEffect(() => {
    if (
      entryWorkspaceId === undefined ||
      workspaceList.phase !== "ready" ||
      list.phase !== "ready"
    ) {
      // A Workspace can disappear and later reappear without remounting the
      // route. Treat that as a fresh entry so a newly active conversation is
      // selected again instead of reviving an obsolete entry snapshot.
      if (entryWorkspaceId === undefined) {
        // oxlint-disable-next-line react/set-state-in-effect -- clear an explicit selection when its Workspace disappears.
        setSelected((current) => (current === undefined ? current : undefined));
      }
      setEntrySelection((current) =>
        current === undefined ? current : undefined,
      );
      return;
    }
    // Capture the first settled selection for this Workspace. Later list
    // updates may reorder rows, but must not steal an explicit selection.
    setEntrySelection((current) =>
      current?.workspaceId === entryWorkspaceId
        ? current
        : {
            workspaceId: entryWorkspaceId,
            ...(entryCandidate === undefined
              ? {}
              : { sessionId: entryCandidate }),
          },
    );
  }, [entryCandidate, entryWorkspaceId, list.phase, workspaceList.phase]);
  const initialSessionId =
    entrySelection && entrySelection.workspaceId === workspace?.id
      ? entrySelection.sessionId
      : entryCandidate;
  const selectedSessionId = resolveCompanionSessionSelection(
    workspace?.id,
    selected,
    availableSessions,
    initialSessionId,
  );
  const [relationship, setRelationship] = useState<RelationshipView>({
    workspacePresent: false,
    revision: 0,
  });
  const [relationshipReadiness, setRelationshipReadiness] =
    useState<CompanionReadiness>("loading");
  const [history, setHistory] = useState<CompanionHistoryView>({
    status: "loading",
    records: [],
    hasEarlier: false,
  });
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  const historyGeneration = useRef(0);
  const historyRequestController = useRef<AbortController>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const cancelHistoryRequest = useCallback(() => {
    historyGeneration.current += 1;
    historyRequestController.current?.abort();
    historyRequestController.current = undefined;
  }, []);
  const onHistoryOpenChange = useCallback(
    (open: boolean) => {
      if (!open) cancelHistoryRequest();
      setHistoryOpen(open);
    },
    [cancelHistoryRequest],
  );
  const [historyRetryKey, setHistoryRetryKey] = useState(0);
  const [voiceCapability, setVoiceCapability] = useState<
    "loading" | "available" | "unavailable"
  >("unavailable");
  const [sessionCreateError, setSessionCreateError] = useState(false);
  const themeRuntime = (
    ctx as unknown as {
      theme?: { getTheme?: () => { active?: { colorScheme?: string } } };
    }
  ).theme;
  const [scheme, setScheme] = useState<"light" | "dark">(() =>
    themeRuntime?.getTheme?.().active?.colorScheme === "dark"
      ? "dark"
      : "light",
  );
  const [recoveryKey, setRecoveryKey] = useState(0);
  const creatingWorkspace = useRef<string>();
  const session = selectedSessionId
    ? ctx.sessions.binding(selectedSessionId as never)?.session
    : undefined;
  const workspaceId = workspace?.id;
  const relationshipOwnedByWorkspace =
    workspaceId !== undefined && relationship.sourceWorkspaceId === workspaceId;
  const historyOwnedByWorkspace =
    workspaceId !== undefined && history.sourceWorkspaceId === workspaceId;
  const visibleRelationship = relationshipOwnedByWorkspace
    ? relationship
    : NEUTRAL_RELATIONSHIP;
  const visibleRelationshipReadiness = relationshipOwnedByWorkspace
    ? relationshipReadiness
    : "loading";
  const visibleHistory = historyOwnedByWorkspace ? history : LOADING_HISTORY;
  const hasActiveSession = Boolean(session);
  const sessionSnapshot = useSnapshot<SessionSnapshot>(
    session,
    session
      ? session.getSnapshot()
      : ({
          sessionId: "",
          queue: [],
          pendingSubmissions: [],
          running: false,
          subagent: null,
          removed: false,
          openState: "cold",
          openError: null,
          hasMore: false,
          loadingOlder: false,
          promptError: null,
          blank: true,
          lastAgentError: null,
          promptAttempted: false,
          awaitingFirstTurn: false,
        } as unknown as SessionSnapshot),
  );
  const conversationBinding = session
    ? ctx.uiConversation.binding(session.sessionId as never)
    : undefined;
  const chatSnapshot = useSnapshot(
    conversationBinding?.target("chat"),
    undefined,
  );
  const contextPressureSource = session?.projections?.faceOf(
    "contextPressure",
  ) as
    | {
        getSnapshot(): ContextPressureProjection | undefined;
        subscribe(listener: () => void): () => void;
      }
    | undefined;
  const contextPressure = useSnapshot<ContextPressureProjection | undefined>(
    contextPressureSource,
    undefined,
  );
  const imageLimitsSource = session?.projections?.faceOf("imageLimits") as
    | {
        getSnapshot(): ImageAttachmentLimits | undefined;
        subscribe(listener: () => void): () => void;
      }
    | undefined;
  const imageLimits = useSnapshot<ImageAttachmentLimits | undefined>(
    imageLimitsSource,
    undefined,
  );
  const continuityLifecycle = useSnapshot<
    CompanionContinuitySnapshot | undefined
  >(conversationBinding?.target(CONTINUITY_VIEW_TARGET), undefined);
  const [submissionHandoff] = useState(() => new SubmissionHandoff());
  const [ttsCache] = useState(() => new TtsPreparationCache());

  useEffect(() => {
    const controller = new AbortController();
    const workspaceId = configured?.workspaceId;
    if (settingsSnapshot.status === "loading") {
      // Mirror the external settings/RPC lifecycle in the local view state.
      // oxlint-disable-next-line react/set-state-in-effect -- synchronize an external relationship source.
      setRelationshipReadiness("loading");
      return () => controller.abort();
    }
    if (!workspaceId) {
      setRelationship({ workspacePresent: false, revision: 0 });
      setRelationshipReadiness("missing");
      return () => controller.abort();
    }
    setRelationship((current) =>
      current.sourceWorkspaceId === workspaceId
        ? current
        : { ...NEUTRAL_RELATIONSHIP, sourceWorkspaceId: workspaceId },
    );
    setRelationshipReadiness("loading");
    const run = async (): Promise<void> => {
      try {
        let result = await connection.rpc.call(
          "/dsh-companion",
          "relationship/get",
          { workspaceId },
          controller.signal,
        );
        while (!controller.signal.aborted) {
          if (!result.ok)
            throw new Error(
              result.error?.message ?? "relationship-unavailable",
            );
          if (controller.signal.aborted) return;
          const next = {
            ...(result.value as RelationshipView),
            sourceWorkspaceId: workspaceId,
          };
          setRelationship(next);
          setRelationshipReadiness(next.workspacePresent ? "ready" : "missing");
          result = await connection.rpc.call(
            "/dsh-companion",
            "relationship/watch",
            { workspaceId, revision: next.revision },
            controller.signal,
          );
        }
      } catch {
        // A carrier/RPC failure is not evidence that the configured Workspace
        // disappeared. Keep the last identity and expose a neutral loading
        // surface until the next connection generation settles.
        if (!controller.signal.aborted) setRelationshipReadiness("error");
      }
    };
    void run();
    return () => controller.abort();
  }, [
    connection,
    configured?.workspaceId,
    connectionState,
    recoveryKey,
    settingsSnapshot.status,
  ]);

  useEffect(() => {
    cancelHistoryRequest();
    if (
      !historyOpen ||
      workspaceReadiness !== "ready" ||
      !workspaceId ||
      !relationshipOwnedByWorkspace ||
      relationshipReadiness !== "ready"
    ) {
      // No configured/settled Workspace has no readable history yet.
      // oxlint-disable-next-line react/set-state-in-effect -- synchronize an external relationship source.
      setHistory({ status: "ready", records: [], hasEarlier: false });
      return cancelHistoryRequest;
    }
    const generation = historyGeneration.current;
    const controller = new AbortController();
    historyRequestController.current = controller;
    setHistory({
      status: "loading",
      sourceWorkspaceId: workspaceId,
      records: [],
      hasEarlier: false,
    });
    void connection.rpc
      .call(
        "/dsh-companion",
        "relationship/history",
        { workspaceId, limit: 10 },
        controller.signal,
      )
      .then((result) => {
        if (
          controller.signal.aborted ||
          generation !== historyGeneration.current ||
          !historyOpen
        )
          return;
        if (!result.ok)
          throw new Error(result.error?.message ?? "history-unavailable");
        const page = historyPageFrom(result.value);
        setHistory({
          status: "ready",
          sourceWorkspaceId: workspaceId,
          ...page,
          loadingEarlier: false,
        });
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          generation !== historyGeneration.current ||
          !historyOpen
        )
          return;
        setHistory({
          status: "error",
          sourceWorkspaceId: workspaceId,
          records: [],
          hasEarlier: false,
        });
      })
      .finally(() => {
        if (historyRequestController.current === controller)
          historyRequestController.current = undefined;
      });
    return cancelHistoryRequest;
  }, [
    cancelHistoryRequest,
    connection,
    connectionState,
    historyRetryKey,
    historyOpen,
    relationshipOwnedByWorkspace,
    relationshipReadiness,
    relationship.revision,
    workspaceReadiness,
    workspaceId,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    if (!workspaceId || !selectedSessionId || !hasActiveSession) {
      // The capability belongs to the selected external session.
      // oxlint-disable-next-line react/set-state-in-effect -- synchronize an external RPC source.
      setVoiceCapability("unavailable");
      return () => controller.abort();
    }
    setVoiceCapability("loading");
    void connection.rpc
      .call(
        "/dsh-companion",
        VOICE_CAPABILITY_ENDPOINT,
        { workspaceId },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        const available =
          result.ok &&
          (result.value as { available?: unknown } | undefined)?.available ===
            true;
        setVoiceCapability(available ? "available" : "unavailable");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setVoiceCapability("unavailable");
      });
    return () => controller.abort();
  }, [
    connection,
    connectionState,
    hasActiveSession,
    recoveryKey,
    selectedSessionId,
    workspaceId,
  ]);

  useEffect(() => {
    const listener = (snapshot: { active?: { colorScheme?: string } }) =>
      setScheme(snapshot.active?.colorScheme === "dark" ? "dark" : "light");
    const dispose = ctx.on("theme/change", listener as never);
    return () => {
      if (typeof dispose === "function") dispose();
    };
  }, [ctx]);

  useEffect(() => {
    // A new session-opening plan clears the previous attempt's error.
    // oxlint-disable-next-line react/set-state-in-effect -- synchronize plan state with external sessions.
    setSessionCreateError(false);
    const plan = companionSessionOpenPlan(
      workspaceList.phase === "ready" && list.phase === "ready",
      workspace?.id,
      selectedSessionId,
    );
    if (!plan) return;
    if (plan.kind === "open") {
      ctx.sessions.open(plan.sessionId as never);
      return;
    }
    if (creatingWorkspace.current === plan.workspaceId) return;
    creatingWorkspace.current = plan.workspaceId;
    let disposed = false;
    void ctx.sessions
      .create({ workspaceId: plan.workspaceId as never })
      .then((id) => {
        if (!disposed) ctx.sessions.open(id);
      })
      .catch(() => {
        if (!disposed) setSessionCreateError(true);
      })
      .finally(() => {
        if (creatingWorkspace.current === plan.workspaceId)
          creatingWorkspace.current = undefined;
      });
    return () => {
      disposed = true;
    };
  }, [
    ctx,
    creatingWorkspace,
    workspace?.id,
    workspaceList.phase,
    list.phase,
    selectedSessionId,
    recoveryKey,
  ]);

  useEffect(
    () => () => {
      ttsCache.dispose();
    },
    [ttsCache],
  );

  const continuity = useMemo(
    () => ({ contextPressure, lifecycle: continuityLifecycle }),
    [contextPressure, continuityLifecycle],
  );
  const projection = useMemo(
    () =>
      projectConversation(
        submissionHandoff.merge(sessionSnapshot, chatSnapshot),
        connectionState === "connected",
        continuity.lifecycle,
      ),
    [
      sessionSnapshot,
      chatSnapshot,
      connectionState,
      continuity.lifecycle,
      submissionHandoff,
    ],
  );
  const resolvedSessionReadiness = resolveSessionReadiness({
    workspace: workspaceReadiness,
    listPhase: list.phase,
    selectedSessionId,
    session,
    snapshot: sessionSnapshot,
  });
  const sessionReadiness: CompanionReadiness = sessionCreateError
    ? "error"
    : resolvedSessionReadiness;
  const identity = useMemo(() => {
    const state = visibleRelationship.state;
    const source = visibleRelationship.identity ?? configured;
    return {
      companionName: source?.companionName ?? "Companion",
      companionAvatar: source?.companionAvatar?.data,
      userName: source?.userName ?? t("you"),
      userAvatar: source?.userAvatar?.data,
      preferredAddress: source?.preferredAddress ?? t("you"),
      signature: state?.signature ?? "",
      mood: state?.mood ?? "neutral",
      moodLabel: state ? t(`mood.${state.mood as Mood}`) : t("mood.neutral"),
      moodNote: state?.note,
      affinity: state?.affinity,
      affinityStage: state ? affinityStage(state.affinity, t) : undefined,
    };
  }, [configured, t, visibleRelationship]);
  const actions = useMemo(() => {
    const rpc: ClientConnectionRpc = connection.rpc;
    return {
      async send(
        text: string,
        images: readonly CompanionImageDraft[],
        onRetire?: (retirement: PendingSubmissionRetirement) => void,
      ): Promise<void> {
        if (!session)
          throw new CompanionPreControllerError("session-unavailable");
        await submitCompanionInput(
          session,
          text,
          images,
          onRetire,
          (requestId, retirement) =>
            submissionHandoff.retire(requestId, retirement.reason),
        );
      },
      async stop(): Promise<void> {
        if (!session) throw new Error("session-unavailable");
        const result = await session.cancel();
        if (!result.ok)
          throw new Error(result.error?.message ?? "cancel-rejected");
      },
      async selectSession(sessionId: string): Promise<void> {
        if (
          !workspace ||
          !availableSessions.some((item) => item.id === sessionId)
        )
          throw new Error("session-not-in-companion-workspace");
        setSelected({ workspaceId: workspace.id, sessionId });
      },
      async loadEarlierHistory(): Promise<void> {
        const current = historyRef.current;
        const before = current.nextBefore;
        if (
          !historyOpen ||
          workspaceReadiness !== "ready" ||
          !workspaceId ||
          !relationshipOwnedByWorkspace ||
          relationshipReadiness !== "ready" ||
          !historyOwnedByWorkspace ||
          current.sourceWorkspaceId !== workspaceId ||
          !current.hasEarlier ||
          before === undefined ||
          current.loadingEarlier
        )
          return;
        cancelHistoryRequest();
        const generation = historyGeneration.current;
        const controller = new AbortController();
        historyRequestController.current = controller;
        setHistory((value) => ({ ...value, loadingEarlier: true }));
        try {
          const result = await rpc.call(
            "/dsh-companion",
            "relationship/history",
            { workspaceId, limit: 10, before },
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            generation !== historyGeneration.current ||
            !historyOpen ||
            workspaceReadiness !== "ready" ||
            !relationshipOwnedByWorkspace ||
            relationshipReadiness !== "ready" ||
            !historyOwnedByWorkspace ||
            historyRef.current.sourceWorkspaceId !== workspaceId ||
            historyRef.current.nextBefore !== before
          )
            return;
          if (!result.ok)
            throw new Error(result.error?.message ?? "history-unavailable");
          const page = historyPageFrom(result.value);
          setHistory((value) => {
            const next: CompanionHistoryView = {
              status: "ready",
              sourceWorkspaceId: workspaceId,
              records: [...value.records, ...page.records],
              hasEarlier: page.hasEarlier,
              loadingEarlier: false,
            };
            if (page.nextBefore !== undefined)
              next.nextBefore = page.nextBefore;
            if (page.predecessor !== undefined)
              next.predecessor = page.predecessor;
            return next;
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            generation !== historyGeneration.current ||
            !historyOpen ||
            workspaceReadiness !== "ready" ||
            !relationshipOwnedByWorkspace ||
            relationshipReadiness !== "ready" ||
            !historyOwnedByWorkspace
          )
            return;
          setHistory((value) => ({
            ...value,
            status: "error",
            loadingEarlier: false,
          }));
          throw error;
        } finally {
          if (historyRequestController.current === controller)
            historyRequestController.current = undefined;
        }
      },
      retryHistory(): void {
        setHistoryRetryKey((value) => value + 1);
      },
      async loadOlder(): Promise<void> {
        await session?.loadOlder();
      },
      async attachmentUrl(attachment: unknown): Promise<string> {
        if (!session) throw new Error("session-unavailable");
        return imageUrl(session, attachment);
      },
      async transcribeVoice(
        recording: VoiceRecording,
        signal?: AbortSignal,
      ): Promise<CompanionVoiceTranscription> {
        if (!session || !workspace || !selectedSessionId)
          throw new Error("session-unavailable");
        const data = await voiceBlobToBase64(
          recording.blob,
          recording.mediaType,
        );
        const result = await rpc.call(
          "/dsh-companion",
          VOICE_TRANSCRIBE_ENDPOINT,
          {
            workspaceId: workspace.id,
            sessionId: String(selectedSessionId),
            mediaType: recording.mediaType,
            data,
          },
          signal,
        );
        if (!result.ok)
          throw new Error(
            result.error?.message ?? t("voice.transcriptionFailed"),
          );
        return normalizeVoiceTranscription(result.value);
      },
      async prepareVoice(text: string): Promise<string> {
        if (!session) throw new Error("session-unavailable");
        const prepared = await ttsCache.prepare(
          String(session.sessionId),
          text,
          {
            synthesize: async (value, sessionId, signal) => {
              const result = await rpc.call(
                TTS_CHANNEL,
                TTS_ENDPOINT,
                { text: value, sessionId },
                signal,
              );
              if (!result.ok) throw new Error(result.error.message);
              return result.value;
            },
          },
        );
        return prepared.url;
      },
    };
  }, [
    t,
    connection.rpc,
    selectedSessionId,
    session,
    submissionHandoff,
    ttsCache,
    availableSessions,
    historyRef,
    workspaceId,
    historyGeneration,
    historyOpen,
    cancelHistoryRequest,
    historyOwnedByWorkspace,
    relationshipOwnedByWorkspace,
    relationshipReadiness,
    workspaceReadiness,
    workspace,
  ]);

  const sessions = useMemo(() => {
    return availableSessions.map((item) => ({
      ...item,
      selected: item.id === selectedSessionId,
    }));
  }, [availableSessions, selectedSessionId]);

  const svelteProps: CompanionBridgeProps = {
    t,
    locale: ctx.locale.getSnapshot().active,
    projection,
    identity,
    scheme,
    continuity,
    actions,
    sessions,
    workspaceReadiness,
    relationshipReadiness: visibleRelationshipReadiness,
    sessionReadiness,
    sessionId: selectedSessionId,
    imageLimits,
    voiceCapability,
    history: visibleHistory,
    onHistoryOpenChange,
    onAdvanced: () => {
      window.location.assign("/");
    },
    onRecovery: () => setRecoveryKey((value) => value + 1),
  };
  // oxlint-disable-next-line react/refs -- action callbacks read request guards only after render.
  return createElement(SvelteMount, { props: svelteProps });
}

function SvelteMount({ props }: { props: CompanionBridgeProps }): JSX.Element {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [propsStore] = useState<Writable<CompanionBridgeProps>>(() =>
    writable(props),
  );
  const assignTarget = useCallback(
    (element: HTMLDivElement | null) => setTarget(element),
    [],
  );

  useEffect(() => {
    if (!target) return undefined;
    const instance = mount(CompanionBridge, { target, props: { propsStore } });
    return () => {
      void unmount(instance);
    };
  }, [propsStore, target]);
  useEffect(() => {
    propsStore.set(props);
  }, [props, propsStore]);
  return createElement("div", {
    ref: assignTarget,
    style: { display: "contents" },
  });
}
