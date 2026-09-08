# dsh-mail

`dsh-mail` is an installable DeepSeek Harness Host + Client plugin for one
Settings-owned Agent mailbox. It provides six model tools backed by a
compatible upstream email MCP and keeps mailbox identity at the Host boundary.

## Install and compose

Install the bundle into the profile that runs the local Web Host:

```sh
dsh plugin --profile web add @lamplitisles/dsh-mail
```

The package contributes its narrow [`cordis.patch.yml`](./cordis.patch.yml)
layer automatically. Enter and save the mailbox in the **Agent mailbox**
Settings card before connecting. The plugin starts safely with no mailbox, but
mail tools and OAuth return an actionable configuration error until one valid
address is saved. One plugin installation uses that one saved address.

The upstream connection is configured in the expanded **Agent mailbox**
Settings card. It provides an MCP endpoint, OAuth issuer, and OAuth callback
URL alongside the mailbox address. New installations receive these defaults:

- MCP endpoint: `https://mail.guion.io/mcp`
- OAuth issuer: `https://guionai.cloudflareaccess.com`
- OAuth callback URL: `http://127.0.0.1:3080/oauth/dsh-mail/callback`

`upstreamEndpoint` and `oauthAuthorizationServer` must be absolute HTTPS URLs.
Fragments are not accepted because they are never sent in HTTP requests, and
the issuer cannot contain a query or fragment. `oauthCallbackUrl` must be an
absolute HTTPS URL or an HTTP URL on a loopback host (`localhost`,
`127.0.0.0/8`, or `::1`) whose pathname is exactly
`/oauth/dsh-mail/callback`; its origin and port may be customized. Save all
four Settings fields together before connecting; the next connection or mail
call uses the saved upstream. Restart the profile after changing bundle
membership; ordinary profile patch edits follow the profile's normal reload
policy.

## What the Agent can do

The model sees only these fixed tools:

| Tool               | Capability                                   |
| ------------------ | -------------------------------------------- |
| `mail_list`        | List messages in the Agent mailbox           |
| `mail_search`      | Search the Agent mailbox                     |
| `mail_read`        | Read one email by provider email ID          |
| `mail_read_thread` | Read one thread by provider thread ID        |
| `mail_send`        | Send a new HTML email from the Agent mailbox |
| `mail_reply`       | Send an HTML reply from the Agent mailbox    |

No model-facing schema contains `mailboxId`, there is no mailbox selector or
enumeration tool, and the upstream MCP's discovered tool set is never mounted
into DSH. Every upstream request receives the configured mailbox at the final
Host-owned call boundary. Provider errors are reduced to safe messages and
secret-looking fields are redacted from tool output.

This is mailbox isolation, not a recipient policy: the Agent may send or reply
without drafts, recipient allowlists, or per-message approval, but it cannot
choose or enumerate another mailbox through these tools. Attachments, drafts,
folder mutation, deletion, polling, and inbound automation are intentionally outside
this package. The Host maps these projections only to the upstream
`list_emails`, `search_emails`, `get_email`, `get_thread`, `send_email`, and
`send_reply` tools. Sends use one `to` address, `subject`, and `bodyHtml`; no
`cc`, `bcc`, or `replyAll` options are exposed.

## Connect local OAuth

Open DSH Settings on the same machine as the Host and expand the **Agent
mailbox** card. The card is collapsed by default. Enter and save the Agent
mailbox address, then select **Connect mailbox** to start the configured OAuth
authorization-code flow with PKCE. The card opens only the returned HTTPS
authorization URL in a new tab.

The Host owns the short-lived single-use state and PKCE verifier. The OAuth
provider must register the configured callback URL. With the default
configuration, register this exact loopback redirect URI:

```text
http://127.0.0.1:3080/oauth/dsh-mail/callback
```

The default endpoint is Guion's `guion-email` service and the default issuer is
Guion's Cloudflare Access issuer. A compatible deployment can replace those
values in the profile, but it must provide the same six upstream operations.

The callback is a plugin-owned WebServer route at
`/oauth/dsh-mail/callback`, not an authenticated `/api` route. A custom HTTPS
deployment must route its configured callback URL to that Host route; this
plugin does not host an external callback server. It exchanges the code, stores
the grant in the plugin-owned DSH credential record `dsh-mail/oauth-grant`, and
returns a minimal no-store success or failure page.
Access and refresh tokens never enter settings, browser card state, model
context, logs, or tool output. The Host resolves the current grant before every
mail call and refreshes it proactively, so DSH does not need to restart after a
normal token refresh.

With the default loopback setup, the local Host must remain reachable at
`127.0.0.1:3080`; do not expose the default callback publicly. A cancelled,
expired, replayed, or provider-rejected attempt stores nothing and leaves a
retryable failure in Settings. This plugin deliberately has no CLI or alternate
authentication fallback.

## Development and packed verification

Run these commands from the workspace root. They use Node.js `>=24.11.0` and
pnpm 12.3.4; all tests use fakes and test-owned state:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/dsh-mail run typecheck
corepack pnpm --filter @lamplitisles/dsh-mail run test
corepack pnpm --filter @lamplitisles/dsh-mail run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-mail run pack-smoke
```

The packed smoke installs the artifact in a disposable real DSH
`0.1.2-rc.1` Web profile, starts a cold Web Host, loads the served client
through the bootstrap's module Loader, and verifies the Host status RPC,
Settings namespace, packed bundle composition, and loopback callback route. It
uses no live credentials, OAuth session, or mailbox. A real OAuth round trip is
an operator check after the local gates pass.

## Independent release

From the workspace root, prepare only this package and an exact matching tag:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-mail v0.1.0 .release-artifacts/dsh-mail
```

Review the verified tarball, then publish it separately with existing npm
credentials at the registry boundary:

```sh
npm publish .release-artifacts/dsh-mail/lamplitisles-dsh-mail-0.1.0.tgz \
  --access public --tag latest
```

Versions are independent across packages. Release preparation does not publish,
deploy, create npm trust configuration, or manage credentials. The package's
mailbox-isolation and loopback-OAuth decisions remain documented in
[`CONTEXT.md`](./CONTEXT.md) and the two ADRs under [`docs/adr`](./docs/adr).
