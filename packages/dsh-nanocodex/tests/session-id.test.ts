import { describe, expect, it } from "vitest";
import { normalizeNanocodexSessionId } from "../src/session-id.js";

describe("Nanocodex session identity normalization", () => {
  it("removes the DSH prefix and canonicalizes the UUID", () => {
    expect(
      normalizeNanocodexSessionId(
        "session-BAF851A1-8AE5-4672-82F9-FE25968781D2",
      ),
    ).toBe("baf851a1-8ae5-4672-82f9-fe25968781d2");
  });

  it("accepts a UUIDv7 DSH identity for the default-generated case", () => {
    expect(
      normalizeNanocodexSessionId(
        "session-018f1f9a-7b3c-7a10-8000-000000000010",
      ),
    ).toBe("018f1f9a-7b3c-7a10-8000-000000000010");
  });

  it("rejects identities outside the DSH session UUID shape", () => {
    expect(() => normalizeNanocodexSessionId("session-1")).toThrow(
      "session-<UUIDv4|UUIDv7>",
    );
    expect(() =>
      normalizeNanocodexSessionId("baf851a1-8ae5-4672-82f9-fe25968781d2"),
    ).toThrow("session-<UUIDv4|UUIDv7>");
  });
});
