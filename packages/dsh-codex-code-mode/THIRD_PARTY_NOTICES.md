# Third-party notices

The parser and text-matching portions of the direct patch tool are ports of
the OpenAI Codex `apply-patch` implementation at commit
`8e6a44b428e31f91b21edc97904fcdf4f0931ade`, specifically its streaming parser,
file-update, sequence-search, and text-file behavior. The port is limited to
Codex `Add File` and `Update File` operations; delete and move operations are
intentionally rejected. The wire grammar follows the same source with those
operations removed.

Sources:

- <https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/assets/tools/apply_patch.lark>
- <https://github.com/openai/codex/tree/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/apply-patch/src>

OpenAI's attribution is reproduced in [`NOTICE`](NOTICE). The port is
distributed under the Apache License 2.0; the package [`LICENSE`](LICENSE)
contains the license text.

The runtime `@earendil-works/pi-ai` dependency is MIT licensed and is shipped
by npm as a separate dependency. DSH packages are peer dependencies supplied by
the Host; their own license notices remain authoritative.
