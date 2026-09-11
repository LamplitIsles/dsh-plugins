---
status: accepted
---

# Keep DSH as the Companion host and embed nanocodex as its engine

Companion retains DSH's application, UI, settings, credentials, and existing integrations. A new agent-loop plugin embeds our nanocodex fork through its supported Node/WASM bindings, using nanocodex's Code Mode runtime and QuickJS WASM evaluator. This reuses the application and engine instead of migrating Companion to a native TUI, building a separate Node application, or adding a Rust-to-Node RPC sidecar.

The plugin replaces the default loop for the selected profile, including its Companion and advanced DSH surfaces. There is one execution engine, with no workspace-based fallback to the previous loop. Existing conversations must continue with their context; preserving the visible transcript alone or starting a fresh session does not satisfy the replacement contract.

Nanocodex owns model execution and active model context. DSH persists the authoritative transcript, and a permanent bidirectional adapter translates session input, output, tools, and lifecycle events throughout every conversation. The fork retains its existing Codex-aligned request, tool, and context behavior. Implementation has two owners: nanocodex for necessary engine/binding changes, and a new plugin in this repository for the DSH adapter. See the [integration design](../nanocodex-companion-engine.md) for recovery, development environments, and acceptance; this decision does not deploy either environment.
