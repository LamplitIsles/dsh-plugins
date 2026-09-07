# DSH Matrix Bridge

This context describes how a Matrix identity carries group-chat messages into an existing DeepSeek Harness companion conversation.

## Language

**Matrix connection**:
A configured Matrix identity consisting of a homeserver, Matrix user ID, and access-token credential.
_Avoid_: Account, bot account

**Workspace binding**:
The required association between a Matrix connection and one DSH workspace whose existing conversation receives Matrix messages.
_Avoid_: Session binding

**Active conversation**:
The existing DSH session in the bound workspace that most recently received a human prompt when the bridge starts. The bridge keeps that conversation for its lifetime and never creates one.
_Avoid_: Matrix session, configured session

**Allowed room**:
The single Matrix room from which the bridge accepts messages and to which it sends replies.
_Avoid_: Channel, chat

**Mention-only mode**:
The default response policy in which a room message triggers the companion only when it mentions, replies to, or literally contains the Matrix identity's current non-empty allowed-room display label. The label comes from local room member state; no profile request is made.
_Avoid_: Silent mode

**Room context buffer**:
The bounded, in-memory sequence of eligible messages from the allowed room that have not yet been supplied to the active conversation. It is drained into one Matrix-triggered prompt when a reply trigger arrives, and is cleared on restart.
_Avoid_: Queue

**Reply trigger**:
An allowed-room message that mentions the Matrix identity, literally contains its current non-empty room display label, or is a verified reply to its message. A reply trigger drains the room context buffer and starts one companion turn.
_Avoid_: Mention

**DSH-only turn completion**:
The final Assistant text recorded when a Companion turn ends. It remains in DSH and never itself emits a Matrix event; a Matrix message is emitted only by an explicit fixed-room Matrix send.
_Avoid_: Automatic Matrix reply, suppressed reply

**Matrix context envelope**:
The deterministic plugin-authored ordinary DSH user message that quotes drained room-context records, uses each sender's current room display label as the primary speaker label alongside stable Matrix sender/event identities, marks them as untrusted data, and names the trigger. Missing labels fall back to the stable ID.
_Avoid_: Raw room transcript, prompt injection

**Matrix provenance**:
The bounded bridge-owned routing metadata retained beside a Matrix context envelope for Host-side attribution. It retains the allowed room, triggering event, sender, relation target when present, and the drained record identities without making the composite user message plugin-sourced or depending on provider serialization for model visibility.
_Avoid_: Provider metadata, mutable room label

**Matrix reply anchor**:
An event ID Matrix verifies in the configured room's server history, selected explicitly by the Agent for an outbound `m.relates_to.m.in_reply_to` relation.
_Avoid_: Automatic reply target, arbitrary event address, thread, quote fallback

**Fixed-room Matrix tools**:
The four native tools scoped to the locked active Companion: `matrix_list_members`, `matrix_read_recent_messages`, `matrix_send_message`, and `matrix_send_file`. None accepts a room ID; all derive the one restart-scoped allowed room, require a usable PREPARED bridge, and disappear when the bridge stops or releases ownership.
_Avoid_: Matrix-wide tools, room selector

**Recent room read**:
A bounded, read-only retrieval of the allowed room's most recent ordinary text records from Matrix, requested by count. It includes human and Matrix-connection-authored records so a restarted Companion can recover conversational context, but does not independently start a Companion turn.
_Avoid_: Automatic restart catch-up, room export

**Matrix companion policy**:
The stable, plugin-authored instructions scoped to the active conversation that define Matrix tool use, explicit delivery, reply-anchor authority, and the untrusted status of room data. It is system-prompt material rather than repeated room-context content.
_Avoid_: Room context, user instruction

**Joined-user roster**:
The bounded sorted `{ userId, displayName }` entries returned by `matrix_list_members` from the allowed room's current joined membership state. `displayName` is the current local room label (possibly SDK-disambiguated) and falls back to `userId`; avatars, profile lookups, presence, power levels, membership history, and other rooms are excluded.
_Avoid_: Member history

**Fixed-room Matrix send**:
The bounded operation performed by `matrix_send_message`, which is the only way a Companion emits an `m.text` event by default (or one `m.audio` event when `voice: true`) to the allowed room through DSH's existing approval and cancellation pipeline. Its optional reply anchor must be an event ID Matrix can retrieve from that room's history; without one it sends an ordinary room message. Its optional `mentions` values are exact, case-sensitive current display labels from the bounded joined-user roster; the bridge resolves them locally to stable Matrix IDs and emits `m.mentions.user_ids` without changing the caller's visible body. Voice text is sent only to the optional `ctx.get("keposSpeech")` service and is uploaded as `语音消息.mp3`; no transcript fallback is emitted. Omitted and empty mentions have the same no-mention behavior. Unknown, stale, duplicate-label, direct-ID, `@room`, and unavailable reply-target inputs fail before send with a bounded JSON correction list of valid display labels. It cannot impersonate, thread, or choose another room.
_Avoid_: Automatic Matrix reply, arbitrary room send

**Workspace file delivery**:
The one-file operation performed by `matrix_send_file`. It resolves one path through the locked Agent's DSH `fs` service, derives the session's workspace root from `session.header.cwd`, verifies canonical containment, accepts only regular files, and reads at most 10 MiB. PNG, JPEG, WebP, and GIF names become `m.image`; all other names become `m.file` with `application/octet-stream`. `description` is the Matrix `body` when supplied, otherwise the basename; `filename` remains the basename. The tool has no room selector, URL or arbitrary host-path escape, MIME override, batch input, retries, or cleanup guarantee.
_Avoid_: Host filesystem access, remote URL delivery, multi-file upload

**Kepos Host Speech service**:
The optional Cordis service named `keposSpeech`, resolved at voice-call time from the locked Agent context. Its only Matrix-facing contract is `synthesize({ sessionId, text }, signal)`, returning `{ mediaType: "audio/mpeg", data: Uint8Array }`; service absence or failure is explicit and never falls back to text.
_Avoid_: Browser-only Kepos RPC, a second provider integration, transcript fallback

**DSH-only proactive turn**:
A Web/CLI-initiated Companion turn that uses the fixed-room send tool. Its bot-authored event is ignored by the bridge, so the turn's final Assistant text remains in DSH and cannot start a Matrix-triggered follow-up.
_Avoid_: Tool-triggered Matrix turn

When an Hindsight companion-memory plugin is enabled, the ordinary user-source
Matrix context envelope participates in that plugin's established durable
user-turn recall and retention boundary. Hindsight's plugin-origin recall
injection remains outside that user-only path.
