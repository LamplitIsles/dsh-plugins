import {
  createRuntime,
  type RuntimeOptions,
  type ServerDefinition,
} from "mcporter";
import {
  GUION_MCP_ENDPOINT,
  MCP_CALL_TIMEOUT_MS,
  MCP_SERVER_NAME,
  UPSTREAM_TOOL_NAMES,
  type UpstreamToolName,
} from "./constants.js";
import { validateHttpsUrl } from "./config.js";

export interface McpRuntimeLike {
  registerDefinition(
    definition: ServerDefinition,
    options?: { overwrite?: boolean },
  ): void;
  callTool(
    server: string,
    toolName: string,
    options?: { args?: unknown; timeoutMs?: number; disableOAuth?: boolean },
  ): Promise<unknown>;
  close(server?: string): Promise<void>;
}

export type RuntimeFactory = (
  options: RuntimeOptions,
) => Promise<McpRuntimeLike>;

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

type UpstreamErrorCategory =
  | "upstream-auth-rejected"
  | "upstream-mailbox-not-found"
  | "upstream-tool-unavailable"
  | "upstream-rejected";

function textContent(content: unknown): string {
  return Array.isArray(content)
    ? content
        .filter(
          (entry): entry is { type?: unknown; text?: unknown } =>
            Boolean(entry) && typeof entry === "object",
        )
        .filter(
          (entry) => entry.type === "text" && typeof entry.text === "string",
        )
        .map((entry) => entry.text)
        .join("\n")
    : "";
}

function upstreamErrorCategory(
  value: Record<string, unknown>,
): UpstreamErrorCategory {
  const text = textContent(value.content);
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?token|access[_ -]?denied|invalid_target/iu.test(
      text,
    )
  ) {
    return "upstream-auth-rejected";
  }
  if (
    /mailbox.{0,80}(not found|unknown|does not exist|unavailable)|(?:not found|unknown|does not exist).{0,80}mailbox/iu.test(
      text,
    )
  ) {
    return "upstream-mailbox-not-found";
  }
  if (
    /unknown tool|tool not found|method not found|unsupported tool/iu.test(text)
  ) {
    return "upstream-tool-unavailable";
  }
  return "upstream-rejected";
}

function asJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => asJson(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      if (
        /token|secret|password|authorization|client_secret|refresh/i.test(key)
      ) {
        output[key] = "[redacted]";
      } else {
        output[key] = asJson(entry, depth + 1);
      }
    }
    return output;
  }
  // This branch is limited to non-JSON primitive values after objects have
  // been recursively projected and is intentionally rendered as text.
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value);
}

/** Project an MCPorter result to safe JSON without exposing provider errors. */
export function normalizeMcpResult(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.isError === true) {
      const category = upstreamErrorCategory(record);
      throw new Error(category);
    }
    if (record.structuredContent !== undefined)
      return asJson(record.structuredContent);
    const text = textContent(record.content);
    if (text) {
      try {
        return asJson(JSON.parse(text));
      } catch {
        return text.slice(0, 64_000);
      }
    }
  }
  return asJson(value);
}

export interface GuionMcpClientOptions {
  readonly endpoint?: string;
  readonly runtimeFactory?: RuntimeFactory;
  readonly clientInfo?: { name: string; version: string };
}

/** One Host capability-local MCPorter runtime with no ambient configuration. */
export class GuionMcpClient {
  private readonly endpoint: string;
  private readonly runtimeFactory: RuntimeFactory;
  private runtimePromise: Promise<McpRuntimeLike> | undefined;
  private runtime: McpRuntimeLike | undefined;
  private registeredToken: string | undefined;
  private closed = false;

  constructor(options: GuionMcpClientOptions = {}) {
    this.endpoint = validateHttpsUrl(
      options.endpoint ?? GUION_MCP_ENDPOINT,
      "upstreamEndpoint",
    );
    this.runtimeFactory =
      options.runtimeFactory ??
      (async (runtimeOptions) => await createRuntime(runtimeOptions));
    this.clientInfo = options.clientInfo ?? {
      name: "dsh-mail",
      version: "0.1.0",
    };
  }

  private readonly clientInfo: { name: string; version: string };

  /** The definition is intentionally inspectable in tests but never model-facing. */
  definition(accessToken: string): ServerDefinition {
    return {
      name: MCP_SERVER_NAME,
      command: {
        kind: "http",
        url: new URL(this.endpoint),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
        },
      },
      allowedTools: [...UPSTREAM_TOOL_NAMES],
      lifecycle: { mode: "keep-alive", idleTimeoutMs: 30_000 },
    };
  }

  async call(
    toolName: UpstreamToolName,
    args: Record<string, unknown>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!UPSTREAM_TOOL_NAMES.includes(toolName))
      throw new Error("upstream-tool-not-allowed");
    if (this.closed) throw new Error("mail-runtime-closed");
    if (signal?.aborted) throw new Error("mail-call-cancelled");
    const runtime = await this.getRuntime();
    if (this.registeredToken !== accessToken) {
      if (this.registeredToken !== undefined)
        await runtime.close(MCP_SERVER_NAME).catch(() => undefined);
      runtime.registerDefinition(this.definition(accessToken), {
        overwrite: true,
      });
      this.registeredToken = accessToken;
    }
    const call = runtime.callTool(MCP_SERVER_NAME, toolName, {
      args,
      timeoutMs: MCP_CALL_TIMEOUT_MS,
      disableOAuth: true,
    });
    return await this.awaitCancellation(call, runtime, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runtime =
      this.runtime ?? (await this.runtimePromise?.catch(() => undefined));
    this.runtime = undefined;
    this.runtimePromise = undefined;
    this.registeredToken = undefined;
    if (runtime) await runtime.close().catch(() => undefined);
  }

  private async getRuntime(): Promise<McpRuntimeLike> {
    if (this.runtime) return this.runtime;
    if (!this.runtimePromise) {
      // `servers: []` is deliberate: no project/home MCPorter configuration or
      // default OAuth vault is consulted by this capability.
      this.runtimePromise = this.runtimeFactory({
        servers: [],
        clientInfo: this.clientInfo,
        logger: quietLogger,
      })
        .then((runtime) => {
          if (this.closed) {
            void runtime.close();
            throw new Error("mail-runtime-closed");
          }
          this.runtime = runtime;
          return runtime;
        })
        .catch((error: unknown) => {
          this.runtimePromise = undefined;
          throw error;
        });
    }
    return await this.runtimePromise;
  }

  private async awaitCancellation(
    call: Promise<unknown>,
    runtime: McpRuntimeLike,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!signal) return normalizeMcpResult(await call);
    let listener: (() => void) | undefined;
    let cancelled: Promise<never> | undefined;
    try {
      if (signal.aborted) throw new Error("mail-call-cancelled");
      cancelled = new Promise<never>((_, reject) => {
        listener = () => {
          this.registeredToken = undefined;
          void runtime.close(MCP_SERVER_NAME).catch(() => undefined);
          reject(new Error("mail-call-cancelled"));
        };
        signal.addEventListener("abort", listener, { once: true });
      });
      const result = await Promise.race([call, cancelled]);
      return normalizeMcpResult(result);
    } finally {
      if (listener) signal.removeEventListener("abort", listener);
      // Keep the original continuation attached after cancellation so a late
      // MCPorter rejection cannot become an unhandled promise.
      void call.catch(() => undefined);
    }
  }
}

export type { RuntimeOptions, ServerDefinition };
