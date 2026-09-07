# dsh-matrix

`@lamplitisles/dsh-matrix` is a DSH `0.1.2-rc.1` plugin that connects one
Matrix identity and one room to one already-existing DeepSeek Harness Companion
conversation. It never creates a session and never changes the conversation
selected after startup.

## Requirements and installation

- DSH `0.1.2-rc.1` with the native web settings surface
- Node.js 24 and pnpm 11.22.0 for workspace development
- A Matrix account that has already joined the allowed room
- The DSH Speech plugin is optional; voice sends require its Host `dshSpeech`
  service, while text and workspace-file sends do not.
- An access token for that account (password and SSO login are not implemented)

Install the published bundle in the DSH deployment that owns your profile:

```sh
dsh plugin --profile web add @lamplitisles/dsh-matrix@0.1.2-rc.1
```

The package declares the DSH Host/client bundle patch. Restart DSH after
installing it, after changing a field, and after revoking/replacing a token.

## Settings

Open the native plugin settings card and fill in:

- **Homeserver URL** — the `https://` (or `http://` for a deliberately local
  deployment) base URL, without a Matrix API path.
- **Matrix user ID** — the full ID, such as `@companion:example.org`, for the
  identity represented by the token.
- **Allowed room ID** — one Matrix room ID, such as `!room:example.org`.
  Messages from every other room are ignored and every reply is sent back only
  to this room.
- **Companion workspace** — selected from the DSH workspace list. The bridge
  inspects this workspace at startup and locks the most recently human-active
  eligible existing session (archived, blank, and subagent sessions are
  excluded). It does not offer a session selector.
- **Element access token** — a write-only DSH credential. Enter a new value to
  replace the stored credential; leaving it blank preserves the existing one.
- **Respond to all messages** — off by default. With it off, a message must
  mention the configured Matrix user in `m.mentions` or be a verified reply to
  a message authored by that user. With it on, every otherwise eligible text
  message in the room can trigger the bridge.

The card shows only whether the credential is configured, never the token.
Readiness is bounded to states such as connecting, bound, unbound, or failed;
provider and Matrix errors are not copied into settings or room messages.

## Getting and revoking an Element token

In Element, open the account/settings area for the account that will be the
bot, find the **Help & About** (or account security) section, and use the
**Access Token** / **Developer** token action exposed by that Element build.
Copy the token once into the DSH card and save. Element's menus differ between
web, desktop, and mobile releases; if the action is not visible, use the
account's supported developer/session-token screen rather than entering a
password into this plugin. The Matrix identity must already have joined the
room; the bridge does not invite or auto-join it.

To revoke a token, use Element's account/session management to sign out or
revoke that session (or revoke all sessions if that is the only control), then
replace or clear the DSH credential and restart DSH. A revoked token cannot be
recovered by the plugin.

## Runtime behavior and security boundary

After startup, the plugin performs one workspace/session selection and opens one
`matrix-js-sdk@42.3.0` client. It begins processing only after initial sync is
prepared. It accepts new `m.room.message` text events from the allowed room and
ignores history, pagination, notices, the bot's own messages,
edits/replacements, threads, empty text, and duplicate event IDs. Reply
fallback markup and the bot mention are removed before the prompt is sent.
Element reply envelopes may include `format`/`formatted_body`; the bridge
verifies the referenced event author and uses only the plaintext `body`.
Formatted HTML is never rendered or treated as prompt content.

Every eligible external text message is captured in timeline order in a
bounded, in-memory room context buffer. In mention-only mode an ordinary
message adds context but does not open a turn. A mention, verified reply, or
literal occurrence of the identity's current non-empty room display label (for
example, `汐`) drains the FIFO buffer atomically (the triggering message
included) into one Matrix-initiated turn; **Respond to all messages** makes each
eligible message a trigger. The label is read from local room member state and
matched as a literal substring, with no profile lookup. Messages that arrive
while a turn is pending stay in the next buffer.

The resulting ordinary DSH user message contains a deterministic
plugin-authored envelope. Each record uses the sender's current room display
label as its primary speaker label alongside the stable Matrix user ID and
event ID; missing labels fall back to the ID. The envelope identifies the
trigger and marks room records as untrusted data. Routing metadata stays
bridge-owned rather than plugin-sourcing the composite, so an enabled Hindsight
companion-memory plugin applies its normal user-turn recall and retention to
the Matrix transcript and final answer; Hindsight's plugin-origin recall
injection remains outside that path. The transcript is durable DSH/model input,
so the selected room is a deliberate privacy boundary.

Admitted prompts are serialized because they share one locked Agent. A turn's
final Assistant text always remains in DSH: it never itself sends a Matrix
event. The Companion must explicitly call the Matrix send tool to deliver a
message. Its optional reply target may be any event that Matrix verifies in
the configured room's server history, including one returned by the recent
message tool. Stable Matrix-use policy is installed once as an
active-Companion-scoped system prompt; each turn injects only the changing room
data and trigger identity.

The locked Companion also receives exactly four native tools in its scoped
conversation:

- **`matrix_list_members`** takes no arguments and returns a bounded (at
  most 128 entries and 16,000 rendered characters), sorted list of
  `{ userId, displayName }` entries for current joined members of the
  configured room only. `displayName` is the current local room label (which
  the Matrix SDK may disambiguate) and falls back to `userId` when unavailable.
  It intentionally omits avatars, presence, power levels, membership history,
  and every other room.
- **`matrix_read_recent_messages`** takes a required integer `last` from 1 to
  50 and reads up to that many latest ordinary text events from the configured room
  through Matrix history, rather than relying on local timeline state after a
  restart. It returns eligible records in chronological order, includes prior
  bot-authored text for conversational continuity, and excludes notices,
  edits, threads, media, and formatted HTML. The result is bounded and remains
  untrusted room data. Calling it does not create a Companion turn.
- **`matrix_send_message`** takes one non-empty plain-text `body` of at most
  16,000 characters, optional `voice` boolean, optional `replyToEventId`, and
  optional `mentions` array. With `voice` omitted or false it emits one
  `m.text` event. With `voice: true`, `body` is passed to the optional
  `ctx.get("dshSpeech")` service as `{ sessionId, text }`; the service must
  return `{ mediaType: "audio/mpeg", data: Uint8Array }`. The bytes are
  uploaded first and exactly one `m.audio` event named `语音消息.mp3` is sent;
  no transcript or text fallback is emitted. If DSH Speech is not mounted, returns
  invalid audio, or the upload/send/readiness operation fails, the call fails
  with a bounded error and sends no fallback event.
  `replyToEventId` must exactly equal an event Matrix can retrieve from the
  configured room's server history; omitting it sends an ordinary room message. Each mention must
  exactly equal one unique current display label in the bounded roster returned
  by `matrix_list_members`; labels are case-sensitive and are not
  trimmed, normalized, guessed, or looked up remotely. The tool resolves those
  labels locally to Matrix user IDs and emits one ordinary `m.text` event with
  `m.mentions: { user_ids: [...] }`. Repeated labels are harmless and produce
  one ID; omitting `mentions` and passing `[]` are identical no-mention calls.
  The caller's body is sent unchanged: the tool does not add visible `@label`
  text, accept Matrix IDs or `@room`, impersonate, create a thread, or reply
  to an event outside the configured room.
  If a label is stale, unknown, or ambiguous (including after a local roster
  change detected before send), the whole call is rejected before any event is
  sent. The bounded error includes the requested label and a JSON list of
  current valid display labels, never roster IDs or raw Matrix errors. The
  normal DSH tool approval and cancellation pipeline still applies. Tools
  return a bounded not-ready error before initial sync is **PREPARED** and after
  a sync **ERROR**; other unavailable Matrix connections produce the same
  bounded failure boundary.
- **`matrix_send_file`** takes exactly one `path` inside the active
  conversation workspace, optional `description`, and optional
  `replyToEventId`. The path is resolved through the live Agent's DSH
  filesystem service (`ctx.get("fs")`), checked for canonical containment in
  the session's workspace root, restricted to a regular file, and read with an
  10 MiB bound. PNG, JPEG, WebP, and GIF names become `m.image`; every other
  accepted name becomes `m.file` with `application/octet-stream`. The visible
  Matrix `body` is `description` when supplied (including an empty string), or
  the source basename otherwise; `filename` is always that basename. The
  upload precedes one event send, and outside paths, URLs, missing/non-regular
  files, oversized/unreadable files, cancellation, unavailable services,
  upload failures, readiness loss, and send failures return bounded errors.
  There is no room selector, host-path escape, URL input, MIME override, or
  batch input.

These registrations and the Matrix policy section belong only to the
startup-locked Companion and are removed when the bridge stops or ownership is
released. A Web/CLI-initiated turn may use the send tool to greet the room or
reply to verified room history; its final Assistant text stays in DSH.

If no eligible conversation existed when DSH started, the Matrix client stays
connected but the bridge remains **unbound** until the next restart. It does
not emit a room message, because tools are the sole Matrix delivery path. Saving
settings never switches the running client or conversation; restart is the
explicit boundary.

The access token is resolved only through the package-owned DSH credential
reference. It is not part of settings snapshots, readiness RPC responses,
provenance, logs, or room replies. The one-room allowlist and one-account
client are hard boundaries, not UI suggestions.

## Unsupported limitations

This rc.1 release intentionally does not support end-to-end encryption or crypto/device
persistence, formatted HTML rendering (formatted reply HTML is
ignored), threads, reactions, moderation,
invites/auto-join, streaming output or `m.replace` edits, multiple rooms or
accounts, per-room/session selection, live switching, automatic session
creation, password/SSO login, durable sync tokens, durable deduplication,
transactional outbox, or exactly-once delivery guarantees. The fixed-room
tools do not provide room selection, profile lookup, presence, power levels,
membership history, invitations, moderation, arbitrary Matrix media/HTML,
threads, reactions, or any other Matrix account capability. Media delivery is
limited to the optional DSH Speech MP3 contract and one bounded workspace file per
call; it does not provide recording, video, albums, retries, progress, or
cleanup of an uploaded-but-unsent object.

## Operator verification

1. Install the package and restart DSH.
2. Select a workspace that already has a normal human prompt, enter the room
   and account values, write the Element token, and save.
3. Restart DSH again and confirm the card reports **bound** (or the expected
   bounded missing/unbound state).
4. In the allowed room, send two ordinary messages followed by a mention,
   verified reply, or the Matrix identity's current room display label. Confirm
   the Companion receives the bounded context but Matrix receives nothing until
   it explicitly calls `matrix_send_message`. Send a notice, edit, thread, and
   another-room message; confirm none enters context.
5. Restart DSH, then in the next Companion turn call
   `matrix_read_recent_messages` with 10 or 20. Confirm it reads bounded
   chronological ordinary text, including a prior bot message when present.
6. Ask the locked Companion to call `matrix_list_members`; verify only bounded
   `{ userId, displayName }` entries from the configured room. Call
   `matrix_send_message` with a short greeting and confirm the single
   plain-text room message and DSH approval prompt. Select an event ID returned
   by `matrix_read_recent_messages` as `replyToEventId`; it must become the Matrix
   reply relation. Then pass exact roster display labels in `mentions` and
   verify the visible body is unchanged while Matrix receives
   `m.mentions.user_ids`. Invalid anchors or labels must send nothing.
   In a separate approved turn call `matrix_send_message` with `voice: true`.
   With DSH Speech mounted, verify one uploaded `语音消息.mp3` `m.audio` event and
   no `m.text` transcript; with the service absent, verify a bounded error and
   no Matrix event. Call `matrix_send_file` with an image and a regular report
   from the active workspace; verify the `m.image`/`m.file` payload, MIME
   mapping, basename/description body, fixed room, reply anchor, and no event
   for an outside or oversized path.
7. Stop/reload DSH and confirm the Matrix client, listeners, queued work, and
   scoped tool registrations stop before a new instance starts. The shared
   Agent remains under DSH SessionController ownership.

## Development and packed verification

Run the package checks from the workspace root. They use Node.js 24 and the
pinned pnpm toolchain:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/dsh-matrix run typecheck
corepack pnpm --filter @lamplitisles/dsh-matrix run test
corepack pnpm --filter @lamplitisles/dsh-matrix run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-matrix run pack-smoke
```

The packed smoke checks the real DSH `0.1.2-rc.1` Host/Loader and Web client
against test-owned state, including the readiness RPC and inlined client CSS.
It sends no Matrix traffic and reads no live credentials.

## Independent release

Prepare only this package and an exact matching tag from the workspace root:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-matrix v0.1.2-rc.1 .release-artifacts/dsh-matrix
```

After reviewing the verified artifact, publish it separately at the npm
registry with existing credentials:

```sh
npm publish .release-artifacts/dsh-matrix/lamplitisles-dsh-matrix-0.1.2-rc.1.tgz \
  --access public --tag beta
```

Package versions remain independent. Release preparation does not publish,
deploy, provision npm trust, or manage credentials; use `og` for Forgejo
operations.
