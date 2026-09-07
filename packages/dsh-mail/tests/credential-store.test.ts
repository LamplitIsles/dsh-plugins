import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../src/index.js";

describe("mail OAuth credential store", () => {
  it("deletes only its owned grant when reconnecting", async () => {
    const deleted: string[] = [];
    const store = createCredentialStore({
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
      deleteRecord: async (key) => { deleted.push(key); }
    }, "dsh-mail/oauth-grant" as never);

    await store.clear("DSH_MAIL_OAUTH_GRANT");

    expect(deleted).toEqual(["dsh-mail/oauth-grant"]);
  });
});
