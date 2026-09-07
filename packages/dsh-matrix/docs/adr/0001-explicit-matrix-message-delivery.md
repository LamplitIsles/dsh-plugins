# Explicit Matrix message delivery

Matrix delivery is performed only by the explicit fixed-room tools: `matrix_send_message` emits one `m.text` event by default or one `m.audio` event when its `voice` flag is true, and `matrix_send_file` emits one bounded workspace `m.image` or `m.file` event. Completing a Companion turn never automatically relays its final Assistant text. The Agent explicitly chooses whether to send and may reply to any event Matrix verifies in the configured room's server history, without gaining another-room event addressing. Voice synthesis is resolved at call time through the optional `ctx.get("keposSpeech")` service; an absent or failed service has no text fallback.

The stable policy that explains these boundaries is an active-Companion-scoped system-prompt section. Per-turn room records and the triggering event remain untrusted dynamic data rather than repeated instructions.
