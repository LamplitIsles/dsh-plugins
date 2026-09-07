# OpenClaw tagged-TTS protocol

Researched 2026-08-30 against OpenClaw `main` commit
[`4432c568`](https://github.com/openclaw/openclaw/tree/4432c568ae330480b50d2aca29b91c5d311d010e).

## Decision for Kepos Speech

Use exactly this one form in the Kepos prompt and parser:

```text
[[tts:text]]早上好，兔海豚。你今天慢慢煮饺子，我隔着屏幕也陪着你。[[/tts:text]]
```

This is OpenClaw's documented **audio-only text block**. Its documentation
describes `[[tts:...]]` as a settings directive and
`[[tts:text]]...[[/tts:text]]` as the optional text block for speech that
should not be visible in the chat reply. The example puts expressive content
such as `(laughs)` inside that block. [OpenClaw TTS documentation,
lines 708–724](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/docs/tools/tts.md#L708-L724)

For Kepos, the configured voice already comes from plugin Settings, so it does
not need per-message voice/model/speed overrides. A single documented
audio-only form keeps the agent contract unambiguous.

## What the other apparent forms mean

| Form | OpenClaw meaning | Use in Kepos |
| --- | --- | --- |
| `[[tts:text]]speech[[/tts:text]]` | Speech payload; it is removed from visible text. | **Yes — the sole agent-emitted format.** |
| `[[tts:speakerVoiceId=... speed=1.1]]` | A key/value directive that overrides provider settings for the reply; it carries no spoken content. | No. |
| `[[tts]]speech[[/tts]]` | A supported plain block: its content is both used as speech text and retained as visible text. | No; it is not the documented form we need. |
| `[[tts:speech]][[/tts:]]` | Not an OpenClaw speech block. The content after `tts:` is parsed as directive tokens, which must be `key=value`; there is no speech payload. | No. |

The parser is explicit about these semantics:

- The `tts:text` block assigns its inner text to the TTS payload and returns an
  empty visible replacement. [Parser lines
  66–73](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/src/tts/directive-facts.ts#L66-L73)
- The plain `tts` block assigns the inner text to the payload **and** returns
  it as visible text. [Parser lines
  75–83](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/src/tts/directive-facts.ts#L75-L83)
- A `tts:...` directive splits its body into whitespace-separated `key=value`
  tokens, strips it from display, and records only valid key/value entries.
  [Parser lines
  85–113](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/src/tts/directive-facts.ts#L85-L113)

## Delivery behavior worth borrowing

With `tts.auto: "tagged"`, OpenClaw requires a directive/block to trigger
audio, and strips directives from streamed visible text, including when tag
delimiters span blocks. [Documentation lines
722–724](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/docs/tools/tts.md#L722-L724)
Its stream cleaner classifies `tts:text` / `/tts:text` as hidden-open and
hidden-close markers. [Source lines
113–171](https://github.com/openclaw/openclaw/blob/4432c568ae330480b50d2aca29b91c5d311d010e/src/tts/directives.ts#L113-L171)

Kepos should therefore parse the complete completed assistant text and display
normal surrounding prose plus an audio control for each `tts:text` segment;
the tag markup itself must not be rendered as prose.
