# Tree Plugin Implementation Plan

Turns `herdr-subagent-tree-plugin-spec.md` into build stages. Live navigator only — no agent control, no history, no sidebar changes.

## Verified against Herdr 0.8.2 (2026-02-17)

- `herdr plugin link <path>` exists for local plugins; `plugin.pane.open` accepts placement `overlay | split | tab | zoomed`. **`popup` from the spec §5 is not available in 0.8.2** — default stays `overlay`.
- Socket API has everything the plugin needs: `session.snapshot` for bootstrap, `events.subscribe` for `pane.agent_status_changed`, `pane.updated`, `pane.moved`, `pane.closed`, `pane.focused`, and `agent.focus` for Enter-to-focus.
- Required subscribe-then-snapshot ordering (buffer events during snapshot) is documented.
- The plugin docs page (`herdr.dev/docs/plugins`) would not load; the exact `herdr-plugin.toml` manifest fields and invocation-context env vars are unverified — Stage 0 is the spike for this.

## Shape

Standalone Node ≥22 plugin, zero runtime dependencies (raw-mode stdin + ANSI rendering, same stdlib-only posture as the rest of the repo). Lives in `tree-plugin/` at repo root:

```text
tree-plugin/
├── herdr-plugin.toml      # one pane entrypoint "tree", one action "open-tree"
├── index.ts               # entrypoint: pane loop, key handling, event pump
├── graph.ts               # pure: agents+metadata → validated tree model
├── render.ts              # pure: tree model → text rows (colors, connectors)
└── test/graph.test.ts     # node:test, same style as existing suite
```

`graph.ts` and `render.ts` are pure and unit-tested without Herdr; `index.ts` is the thin impure shell (~socket I/O, stdin, redraw).

## Stages

### Stage 0 — Spike (half a day)
1. Write minimal `herdr-plugin.toml` + hello-world pane; `herdr plugin link tree-plugin/`.
2. Confirm from the running plugin: manifest schema, pane entrypoint invocation, whether the action receives the focused pane/workspace as context (spec §11 scope rules depend on it), and `HERDR_PLUGIN_STATE_DIR`.
3. Fallback if context is absent: default scope = all roots in current workspace via `HERDR_WORKSPACE_ID`.

**Exit:** `open-tree` opens a pane that prints text and exits cleanly on `q`.

### Stage 1 — Graph (pure, fully testable)
`graph.ts`:
1. Input: `session.snapshot` agent/pane records + per-pane delegation tokens (`pane.get` / snapshot metadata).
2. Build nodes; parent links from `delegation_parent`; **compute depth from links, ignore `delegation_depth` except as diagnostic** (spec §7).
3. Invalid-relationship handling: missing parent → `unattached` group; cycle → break edge with lexicographically-last child pane ID and mark node; duplicate `delegation_id` → keep both, mark duplicate; non-agent parent → unattached.
4. Scope resolution: focused root tree → workspace roots → all roots.
5. Sibling sort: Herdr pane order, then label.

Tests cover: happy tree, depth-3 nesting, missing parent, cycle, duplicate ID, empty state. Reuses token-name constants — import or mirror them from `.pi/extensions/subagent/helpers.ts` so producer and consumer can't drift.

**Exit:** `node --test tree-plugin/test/` green; graph is spec-§7 complete.

### Stage 2 — Live UI
`index.ts`:
1. Connect socket → `events.subscribe` (pane status/metadata/move/close/focused + workspace/tab events) → `session.snapshot` → apply buffered events (documented ordering).
2. Render via `render.ts`: connector tree, label, model+thinking, status, workspace suffix when different from root, invalid markers. ANSI, sanitized (control-char strip — reuse `cleanLabel` discipline).
3. Keys: `j/k`/arrows move, `h/l` collapse/expand, Space toggle, Enter → `agent.focus`, `r` → resnapshot, `q`/Esc close.
4. Redraw coalescing: events within a 100 ms window collapse into one render (spec §14).
5. Reconnect with bounded backoff; on reconnect, resnapshot before applying new events.

**Exit:** against a real `herdr agent start` delegation, statuses update live, Enter focuses, collapse state survives redraws.

### Stage 3 — Degraded states + acceptance sweep
- Empty state (no roots in scope), socket-disconnected banner, invalid-metadata markers.
- Walk AC-2 through AC-9 from the spec; AC-12 (non-Pi producer) spot-checked by hand-reporting tokens via `pane.report_metadata` from a shell one-liner.

## Explicit non-goals (unchanged)

No spawning/prompting/closing agents, no session-file parsing, no persistence across Herdr restarts, no `agent.view.set` global projection, no second relationship database. Completed children vanish when their panes close — that's the spec'd v1 behaviour, revisit only if the experiment proves a history is wanted.

## Sequencing note

Stage 1 can start immediately (pure code + tests against recorded snapshot fixtures). Stage 0 gates only `index.ts`. Total estimate: ~2–3 days for one person, with Stage 0's manifest discovery being the main schedule risk.
