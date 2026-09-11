# Third-party notices

The direct `apply_patch` tool carries the parser, matcher, and text-file
portions of OpenAI Codex at commit
`8e6a44b428e31f91b21edc97904fcdf4f0931ade`. It is limited to Codex `Add File`
and `Update File` operations; Delete File and Move to are intentionally
rejected. The wire grammar follows the same source with those operations
removed.

Sources:

- <https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/assets/tools/apply_patch.lark>
- <https://github.com/openai/codex/tree/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/apply-patch/src>

OpenAI's attribution is reproduced in [`NOTICE`](NOTICE). The port is
distributed under the Apache License 2.0; [`LICENSE`](LICENSE) contains the
license text.

This package carries the packed JavaScript and WebAssembly runtime from the
Nanocodex project and its platform-neutral tool package so the DSH artifact does
not depend on a sibling checkout.

- `vendor/nanocodex` — Nanocodex, version 0.5.0, licensed under MIT OR Apache-2.0.
  Source: <https://github.com/gakonst/nanocodex>.
- `vendor/nanocodex-tools` — nanocodex-tools, version 0.1.0, licensed under MIT
  OR Apache-2.0. Source: <https://github.com/gakonst/nanocodex>.

The exact local source checkout and packing procedure are recorded in
[`docs/nanocodex-companion-engine.md`](../../docs/nanocodex-companion-engine.md).
