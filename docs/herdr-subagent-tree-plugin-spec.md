# Herdr Subagent Tree Plugin

**Status:** Draft  
**Companion specification:** [Pi Subagent Delegation Extension](./pi-subagent-extension-spec.md)

## 1. Purpose

Display agent delegation as a navigable parent-child tree in Herdr.

The plugin consumes generic relationship metadata attached to Herdr panes. It does not spawn agents, determine their semantic status, or depend on Pi session internals. Although the first producer is the Pi subagent extension, the tree model is intended to support any agent or orchestration system.

## 2. Platform constraint

Herdr plugin v1 cannot replace or structurally extend the built-in Agents sidebar. It can:

- run executable actions and event hooks;
- use the full Herdr CLI and socket API;
- subscribe to agent and pane events;
- own durable files under `HERDR_PLUGIN_STATE_DIR`;
- open terminal panes, tabs, overlays, and popups;
- apply a flat `agent.view.set` filter and sort projection.

Therefore version one renders the tree in a plugin-owned terminal UI. Native sidebar nesting is deferred until Herdr exposes a hierarchical Agent-view contract.

## 3. Goals

- Show root agents and delegated descendants as a tree.
- Use Herdr's existing `idle`, `working`, `blocked`, `done`, and `unknown` states.
- Update without polling terminal screens.
- Focus a selected agent's pane.
- Collapse and expand subtrees.
- Work with delegation metadata from any producer.
- Remain read-only with respect to agent processes in version one.

## 4. Non-goals

- Spawning, prompting, interrupting, or closing agents.
- Replacing Herdr agent detection or lifecycle integrations.
- Parsing Pi, Claude, Codex, or other agent session files.
- Modifying the built-in Agents sidebar.
- Installing an always-active global `agent.view.set` projection.
- Managing worktrees or merging child changes.
- Delivering child results to an orchestrating agent.
- Editing Herdr configuration automatically.
- Persisting relationships across a cold Herdr restart.

## 5. Plugin package

Conceptual package structure:

```text
herdr-subagent-tree/
├── herdr-plugin.toml
└── tree-ui
```

The implementation language is not prescribed. The executable must use `HERDR_BIN_PATH` for simple commands and `HERDR_SOCKET_PATH` for its long-lived event subscription.

### Manifest surface

The plugin declares:

- one pane entrypoint named `tree`;
- one action named `open-tree`.

The default pane placement is `overlay`. The user may request `tab`, `split`, `zoomed`, or `popup` through Herdr's normal plugin-pane options.

No runtime action registration is required.

## 6. Producer contract

A producer reports delegation metadata on agent panes using `pane.report_metadata`. Metadata is display-only; semantic agent state remains owned by Herdr.

### Required child tokens

| Token | Type | Meaning |
|---|---|---|
| `delegation_id` | String | Producer-generated identifier unique within the delegation root. |
| `delegation_parent` | Pane ID | Direct parent's Herdr pane ID. |
| `delegation_root` | Pane ID | Root orchestrator's Herdr pane ID. |
| `delegation_depth` | Unsigned integer encoded as text | Producer's expected depth. |
| `delegation_label` | String | Human-readable assignment label. |
| `delegation_model` | String | Model used by the agent. |
| `delegation_thinking` | String | Parent-selected thinking level used by the child. |

### Required root tokens

| Token | Value |
|---|---|
| `delegation_root` | Root agent's own pane ID. |
| `delegation_depth` | `0`. |
| `delegation_label` | Root session or task label. |
| `delegation_model` | Root model when known. |

`delegation_id` and `delegation_parent` are absent on roots.

### Constraints

- Token names and values must satisfy Herdr metadata limits.
- Pane IDs are treated as opaque strings.
- Metadata reports must not override semantic lifecycle state.
- Producers should omit TTL while the pane exists.
- Producers may set `display_agent`; the plugin does not depend on it.
- Unknown additional tokens are ignored.

The companion Pi extension reports metadata with source `pi:subagent`. Other producers may use their own valid source identifiers.

## 7. Data model

### Agent node

Each displayed node contains:

```text
pane_id
canonical_agent
status
seen
workspace_id
tab_id
delegation_id?
thinking_level?
parent_pane_id?
root_pane_id
label
model?
children[]
```

Herdr agent data is authoritative for identity, location, status, and focus. Delegation metadata is authoritative only for relationships and labels.

### Graph construction

1. Load the current agent list.
2. Read delegation tokens from each agent's pane metadata.
3. Treat a node with `delegation_root == pane_id` and no parent as a root.
4. Attach a child only when `delegation_parent` identifies a known pane.
5. Compute depth from parent links rather than trusting `delegation_depth`.
6. Use `delegation_depth` only for diagnostics and recovery hints.
7. Sort siblings by Herdr pane order, then label.

### Invalid relationships

- Missing parent: display beneath an **Unattached** group.
- Parent in another workspace: allow it and show the parent's workspace label.
- Cycle: break the edge whose child pane ID sorts last and mark that node invalid.
- Duplicate delegation ID under one root: retain both nodes and mark the duplicate.
- Non-agent parent pane: treat as unattached until an agent appears there.

Invalid metadata must never crash or hide unrelated agents.

## 8. Tree UI

### Default scope

When opened from a pane containing a delegation root or descendant, show that root's complete tree.

Otherwise show all delegation roots in the current workspace. If none exist, show an empty-state message rather than unrelated standalone agents.

### Row presentation

Conceptual display:

```text
▼ Main task · GPT-6 Astra                              working
  ├─ Map authentication · GPT-5.6                     done
  ├─ Review session handling · GPT-6 Astra             blocked
  └─ Implement validation · GPT-5.6                    working
```

Each row shows:

- tree connector and expansion state;
- delegation label;
- model and thinking level when known;
- semantic Herdr status;
- workspace name when different from the root;
- a marker for invalid or unattached relationships.

Color and status symbols should follow Herdr conventions where those values are available to the plugin.

### Interaction

| Input | Action |
|---|---|
| Up/Down or `j`/`k` | Move selection. |
| Left or `h` | Collapse the selected node or select its parent. |
| Right or `l` | Expand the selected node or select its first child. |
| Enter | Focus the selected agent pane through Herdr. |
| Space | Toggle expansion. |
| `r` | Rebuild from the latest Herdr snapshot. |
| `q` or Escape | Close the plugin UI. |

The plugin does not send input to agents.

### Empty and degraded states

The UI distinguishes:

- no delegation trees in scope;
- Herdr socket disconnected;
- invalid relationship metadata.

## 9. Live updates

On startup, the tree UI takes one complete Herdr snapshot and then subscribes to relevant events.

Relevant changes include:

- `pane.agent_detected` and `pane.agent_status_changed`;
- `pane.updated`, including presentation metadata changes;
- `pane.moved` and `pane.closed`;
- tab or workspace move, rename, and close events.

The UI updates the affected nodes and redraws. If the subscription disconnects, it reconnects with bounded backoff and rebuilds from a fresh snapshot before applying more events.

Terminal screen contents are never polled or parsed.

## 10. Restart behaviour

The plugin rebuilds its tree from live Herdr metadata whenever it opens or reconnects. Herdr does not restore token metadata after a cold server restart, so version one may show no relationships until producers report them again.

The plugin does not keep a second relationship database. Persistence belongs in a future Herdr-native relationship API if the experiment proves useful.

## 11. Plugin action and pane lifecycle

### `open-tree`

The action opens or focuses the plugin's `tree` pane.

Invocation context determines the initial scope:

1. focused agent's root tree;
2. focused workspace;
3. all known roots as a fallback.

Opening a second tree UI for the same Herdr session should focus the existing plugin pane where practical rather than creating duplicates.

Closing the plugin UI does not alter agents, panes, or metadata.

## 12. Relationship ownership

The plugin consumes relationship reports but does not decide whether a delegation is allowed.

Responsibilities remain separated:

| Concern | Owner |
|---|---|
| Task decomposition and model choice | Parent agent |
| Model, tool, concurrency, and recursion policy | Orchestration extension |
| Child process and result delivery | Orchestration extension |
| Agent semantic status and pane lifecycle | Herdr core/integration |
| Delegation relationship presentation | This plugin |

This separation prevents the UI plugin from becoming another orchestration engine.

## 13. Security

- Plugin commands run as the user and are not sandboxed.
- Socket data and plugin context may contain sensitive paths and titles.
- The plugin keeps relationship identifiers and display labels only in memory.
- Display strings are treated as untrusted data and sanitized before terminal rendering.
- No metadata value is executed as a command.
- Focusing an agent is the only agent-affecting action in version one.
- The plugin never changes lifecycle authority with `pane.report_agent`.

## 14. Performance

- Initial state comes from one complete snapshot.
- Steady-state updates are event-driven.
- Rebuilding the graph is acceptable because the expected agent count is small.
- Rendering must remain responsive with at least 100 displayed agents and depth 8.
- Event bursts may be coalesced into one redraw.

## 15. Acceptance criteria

- [ ] AC-1: The plugin installs or links through Herdr's normal plugin mechanism.
- [ ] AC-2: `open-tree` opens a plugin-owned tree UI.
- [ ] AC-3: A root and its children render according to the producer contract.
- [ ] AC-4: Nested descendants render at their computed depth.
- [ ] AC-5: Agent statuses update from Herdr events without screen polling.
- [ ] AC-6: Enter focuses the selected agent pane.
- [ ] AC-7: Nodes can be collapsed and expanded.
- [ ] AC-8: Missing parents appear under **Unattached**.
- [ ] AC-9: Cyclic metadata does not crash the UI.
- [ ] AC-10: Closing the plugin UI leaves agents untouched.
- [ ] AC-11: The plugin does not install a global Agent-view projection.
- [ ] AC-12: The plugin works with a non-Pi producer using the same metadata contract.

## 16. Future native Herdr support

If the plugin validates the interaction model, Herdr may add a first-class relationship API, conceptually:

```ts
agent.relationship.report({
  childPaneId: string,
  parentPaneId: string,
  kind: "delegated",
  label?: string,
});
```

A native contract could support:

- hierarchy in the built-in Agents sidebar;
- collapse and expansion across desktop and mobile views;
- parent and child navigation;
- descendant status roll-up;
- relationship persistence with session state;
- removal of token-based relationship reconstruction.

The plugin should then become a producer/configuration layer or be retired if core Herdr fully covers the use case.

## 17. References

- [Herdr plugins](https://herdr.dev/docs/plugins/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Herdr agents](https://herdr.dev/docs/agents/)
