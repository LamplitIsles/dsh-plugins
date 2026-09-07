# Bounded Matrix media delivery

Media delivery remains an explicit, fixed-room capability scoped to the locked
Companion. `matrix_send_message` may synthesize one MP3 through the optional
Kepos Speech service and upload it as one `m.audio` event named `语音消息.mp3`; it never
sends a transcript. `matrix_send_file` resolves exactly one path through the
live Agent's DSH filesystem service, verifies containment in
`session.header.cwd`, accepts only regular files, and reads at most 10 MiB.
Recognized image extensions become `m.image`, and every other file becomes
`m.file` with `application/octet-stream`. Upload happens before the event send;
validation, cancellation, readiness, upload, and send failures are bounded and
never trigger fallback text. An uploaded-but-unsent object may remain because
this plugin does not own an outbox or cleanup contract.
