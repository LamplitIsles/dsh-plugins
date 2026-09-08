import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import {
  MAX_TOOL_TEXT_LENGTH,
  UPSTREAM_TOOL_NAMES,
  type UpstreamToolName,
} from "./constants.js";

export const MAIL_LIST = "mail_list" as const;
export const MAIL_SEARCH = "mail_search" as const;
export const MAIL_READ = "mail_read" as const;
export const MAIL_READ_THREAD = "mail_read_thread" as const;
export const MAIL_SEND = "mail_send" as const;
export const MAIL_REPLY = "mail_reply" as const;

export const MAIL_TOOL_NAMES = Object.freeze([
  MAIL_LIST,
  MAIL_SEARCH,
  MAIL_READ,
  MAIL_READ_THREAD,
  MAIL_SEND,
  MAIL_REPLY,
] as const);

export interface MailToolDependencies {
  readonly call: (
    tool: UpstreamToolName,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface MailToolResult {
  readonly data: JsonValue;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

type RecordArgs = Record<string, unknown>;

function signalOf(exec: ToolRunContext): AbortSignal {
  return exec.signal;
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Mail operation cancelled.");
}

function boundedString(
  value: unknown,
  field: string,
  required = false,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_TOOL_TEXT_LENGTH ||
    (required && value.trim().length === 0)
  ) {
    throw new Error(
      `Mail ${field} must be a non-empty string of at most ${MAX_TOOL_TEXT_LENGTH} characters.`,
    );
  }
  return value;
}

function boundedLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    throw new Error("Mail limit must be an integer from 1 to 100.");
  }
  return value;
}

function boundedPage(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 10_000
  ) {
    throw new Error("Mail page must be an integer from 1 to 10000.");
  }
  return value;
}

function output(value: unknown): MailToolResult {
  return { data: toJson(value) };
}

function toJson(value: unknown, depth = 0): JsonValue {
  if (depth > 12 || value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => toJson(entry, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      result[key] =
        /token|secret|password|authorization|client_secret|refresh/i.test(key)
          ? "[redacted]"
          : toJson(entry, depth + 1);
    }
    return result;
  }
  // This branch is limited to non-JSON primitive values after objects have
  // been recursively projected and is intentionally rendered as text.
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value);
}

function renderValue(value: {
  readonly data: JsonValue;
}): { type: "text"; text: string }[] {
  let text: string;
  try {
    text = JSON.stringify(value.data);
  } catch {
    text = "{}";
  }
  return [{ type: "text", text: text.slice(0, MAX_TOOL_TEXT_LENGTH) }];
}

async function invoke(
  deps: MailToolDependencies,
  tool: UpstreamToolName,
  input: RecordArgs,
  exec: ToolRunContext,
): Promise<MailToolResult> {
  const signal = signalOf(exec);
  abortIfNeeded(signal);
  // The input object is built from an explicit allowlist. MailService adds the
  // saved mailbox only at its final Host-owned upstream boundary.
  const args = input;
  try {
    const data = await deps.call(tool, args, signal);
    abortIfNeeded(signal);
    return output(data);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.message === "Mail operation cancelled.")
    ) {
      throw new Error("Mail operation cancelled.");
    }
    if (
      error instanceof Error &&
      error.message.startsWith("Mail is not connected")
    )
      throw error;
    if (
      error instanceof Error &&
      error.message.includes("authorization expired")
    )
      throw error;
    if (error instanceof Error && error.message === "upstream-auth-rejected") {
      throw new Error(
        "The upstream mail service rejected the authorization. Reconnect the mailbox from DSH Settings.",
      );
    }
    if (
      error instanceof Error &&
      error.message === "upstream-mailbox-not-found"
    ) {
      throw new Error(
        "The configured Agent mailbox does not exist in the upstream mail service or is not available to this authorization. Check the mailbox address in DSH Settings.",
      );
    }
    if (
      error instanceof Error &&
      error.message === "upstream-tool-unavailable"
    ) {
      throw new Error(
        "The upstream mail service does not expose a required mail operation.",
      );
    }
    throw new Error("The upstream mail request failed.");
  }
}

const mailOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { data: { type: "json", required: true } },
} as const;

export function createMailToolDefinitions(
  deps: MailToolDependencies,
): readonly ToolDefinition[] {
  const list = defineTool({
    name: MAIL_LIST,
    description:
      "List messages in the Agent mailbox. The mailbox is fixed by the plugin and cannot be selected by the model.",
    parameters: {
      folder: {
        type: "string",
        description: "Optional mailbox folder to list.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of messages to return (1-100).",
      },
      page: {
        type: "integer",
        description: "Page number for pagination (1-10000).",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const record = args as RecordArgs;
      const folder =
        record.folder === undefined
          ? undefined
          : boundedString(record.folder, "folder");
      const limit = boundedLimit(record.limit);
      const page = boundedPage(record.page);
      return await invoke(
        deps,
        "list_emails",
        {
          ...(folder === undefined ? {} : { folder }),
          ...(limit === undefined ? {} : { limit }),
          ...(page === undefined ? {} : { page }),
        },
        exec,
      );
    },
  });

  const search = defineTool({
    name: MAIL_SEARCH,
    description:
      "Search messages in the Agent mailbox. Search results never change which mailbox is used.",
    parameters: {
      query: { type: "string", required: true, description: "Search terms." },
      folder: {
        type: "string",
        description: "Optional mailbox folder to search.",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const record = args as RecordArgs;
      const query = boundedString(record.query, "query", true)!;
      const folder =
        record.folder === undefined
          ? undefined
          : boundedString(record.folder, "folder");
      return await invoke(
        deps,
        "search_emails",
        { query, ...(folder === undefined ? {} : { folder }) },
        exec,
      );
    },
  });

  const read = defineTool({
    name: MAIL_READ,
    description:
      "Read one email by its provider email ID from the Agent mailbox.",
    parameters: {
      emailId: {
        type: "string",
        required: true,
        description: "Provider email ID.",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const emailId = boundedString(
        (args as RecordArgs).emailId,
        "emailId",
        true,
      )!;
      return await invoke(deps, "get_email", { emailId }, exec);
    },
  });

  const readThread = defineTool({
    name: MAIL_READ_THREAD,
    description:
      "Read one conversation thread by its provider thread ID from the Agent mailbox.",
    parameters: {
      threadId: {
        type: "string",
        required: true,
        description: "Provider thread ID.",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const threadId = boundedString(
        (args as RecordArgs).threadId,
        "threadId",
        true,
      )!;
      return await invoke(deps, "get_thread", { threadId }, exec);
    },
  });

  const send = defineTool({
    name: MAIL_SEND,
    description:
      "Send a new HTML email from the Agent mailbox. There is no recipient allowlist or draft step.",
    parameters: {
      to: {
        type: "string",
        required: true,
        description: "Recipient email address.",
      },
      subject: {
        type: "string",
        required: true,
        description: "Email subject.",
      },
      bodyHtml: {
        type: "string",
        required: true,
        description: "HTML email body.",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const record = args as RecordArgs;
      const to = boundedString(record.to, "to", true)!;
      const subject = boundedString(record.subject, "subject", true)!;
      const bodyHtml = boundedString(record.bodyHtml, "bodyHtml", true)!;
      return await invoke(deps, "send_email", { to, subject, bodyHtml }, exec);
    },
  });

  const reply = defineTool({
    name: MAIL_REPLY,
    description:
      "Send an HTML reply from the Agent mailbox. There is no draft or approval step.",
    parameters: {
      originalEmailId: {
        type: "string",
        required: true,
        description: "Provider email ID to reply to.",
      },
      to: {
        type: "string",
        required: true,
        description: "Recipient email address.",
      },
      subject: {
        type: "string",
        required: true,
        description: "Reply subject.",
      },
      bodyHtml: {
        type: "string",
        required: true,
        description: "HTML reply body.",
      },
    },
    output: {
      schema: mailOutputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec): Promise<MailToolResult> {
      const record = args as RecordArgs;
      const originalEmailId = boundedString(
        record.originalEmailId,
        "originalEmailId",
        true,
      )!;
      const to = boundedString(record.to, "to", true)!;
      const subject = boundedString(record.subject, "subject", true)!;
      const bodyHtml = boundedString(record.bodyHtml, "bodyHtml", true)!;
      return await invoke(
        deps,
        "send_reply",
        { originalEmailId, to, subject, bodyHtml },
        exec,
      );
    },
  });

  return [list, search, read, readThread, send, reply];
}

export { UPSTREAM_TOOL_NAMES };
