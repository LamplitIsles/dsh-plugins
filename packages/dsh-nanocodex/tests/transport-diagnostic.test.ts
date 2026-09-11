import { describe, expect, it } from "vitest";
import { transportFallbackDiagnostic } from "../src/transport-diagnostic.js";

describe("Nanocodex transport fallback diagnostics", () => {
  it("projects only the allowlisted correlated transport fields", () => {
    const diagnostic = transportFallbackDiagnostic(
      "session-baf851a1-8ae5-4672-82f9-fe25968781d2",
      {
        protocol_version: 1,
        request_id: "baf851a1-8ae5-4672-82f9-fe25968781d2",
        seq: 4,
        type: "model.attempt.retrying",
        payload: {
          error_class: "websocket_fallback",
          previous_transport: "responses_websocket_v2",
          next_transport: "responses_https_sse",
          reason: "upgrade_required",
          error: "Bearer secret and private prompt",
        },
      },
    );

    expect(diagnostic).toEqual({
      kind: "nanocodex.transport_fallback",
      session_id: "session-baf851a1-8ae5-4672-82f9-fe25968781d2",
      request_id: "baf851a1-8ae5-4672-82f9-fe25968781d2",
      error_class: "websocket_fallback",
      previous_transport: "responses_websocket_v2",
      next_transport: "responses_https_sse",
      reason: "upgrade_required",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Bearer|private prompt/iu);
  });

  it("ignores unrelated or malformed engine events", () => {
    expect(
      transportFallbackDiagnostic("session-test", {
        protocol_version: 1,
        request_id: "request",
        seq: 1,
        type: "assistant.delta",
        payload: { text: "visible output" },
      }),
    ).toBeUndefined();
    expect(
      transportFallbackDiagnostic("session-test", {
        protocol_version: 1,
        request_id: "request",
        seq: 2,
        type: "model.attempt.retrying",
        payload: {
          error_class: "websocket_fallback",
          previous_transport: "responses_websocket_v2",
          next_transport: "responses_https_sse",
          reason: "provider_bug",
        },
      }),
    ).toBeUndefined();
  });
});
