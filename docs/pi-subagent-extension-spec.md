# Pi Subagent Delegation Extension

**Status:** Draft  
**Companion specification:** [Herdr Subagent Tree Plugin](./herdr-subagent-tree-plugin-spec.md)

## 1. Purpose

Provide Pi with one generic delegation tool that lets the active model create autonomous subagents without predefined agent files.

The parent model writes each assignment and chooses its model. The extension enforces model, capability, concurrency, and lifecycle policy. Herdr supplies terminal panes and agent status.

## 2. Design principles

1. **Tasks define temporary roles.** No scout, worker, planner, or reviewer definitions are required.
2. **Policy stays outside prompts.** Models cannot grant themselves models, tools, or recursion.
3. **The parent remains the manager.** Children return results to the parent; they do not take over its conversation.
4. **Herdr is the status authority.** The extension does not maintain a duplicate liveness state machine or Pi widget.
5. **Pi sessions are the result authority.** Final output comes from the child session, not terminal screen scraping.
6. **Version one is deliberately narrow.** Autonomous delegation with explicit child-count and depth ceilings only.

## 3. Goals

- Expose one `subagent` tool to the parent model.
- Let the parent write a self-contained child task.
- Let the parent choose an allowed model explicitly.
- Support several independent subagents running concurrently.
- Support bounded recursive delegation when `maxDepth` permits it.
- Show every child as a normal Herdr-managed Pi agent.
- Report parent-child metadata for the companion Herdr plugin.
- Deliver completion, failure, blocked, and child progress notifications back into the parent Pi session.
- Let the parent nudge a running child and answer a child's blocking decision request.
- Preserve child session files for inspection after completion.

## 4. Non-goals

- Static agent definitions or an agent catalogue.
- Unbounded recursion or a shared tree-wide token/cost budget.
- General session discovery, arbitrary peer messaging, mailboxes, attachments, or chat UI.
- Resuming a completed child through the messaging channel.
- Workflow templates such as scout → planner → worker.
- Worktree creation or merge orchestration.
- Supporting multiplexers other than Herdr.
- Replacing Herdr's status detection.
- Surviving termination of the parent Pi process while children are running.

## 5. User-visible tool

### `subagent`

Starts one autonomous child Pi session in a Herdr pane and returns after launch. Completion is delivered asynchronously.

Conceptual input:

```ts
{
  name: string;
  task: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  cwd?: string;
}
```

### Fields

| Field | Required | Meaning |
|---|---:|---|
| `name` | Yes | Short human-readable task label used as the child pane title and shown in Pi and Herdr. |
| `task` | Yes | Complete assignment given to the child. |
| `model` | Yes | Exact model selected from the advertised delegation pool. |
| `thinking` | Yes | Child thinking level selected by the parent for this task. |
| `cwd` | No | Child working directory. Defaults to the parent working directory. |

Every child receives a fixed built-in tool allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, plus the extension-owned `contact_supervisor`, `subagent`, and `subagent_message` tools. Pi extension discovery is disabled; only the Herdr Pi integration, child messaging extension, and subagent extension are loaded explicitly. Children below `maxDepth` may delegate; at the limit, `subagent` and `subagent_message` are removed from the active tool set. No unrelated extension tools are loaded. Per-task tool profiles are deferred until there is evidence they are needed.

### `subagent_message`

Sends a live message from the parent to one running child:

```ts
{
  id: string;
  message: string;
  replyTo?: string;
}
```

`id` is the exact delegation ID returned by `subagent`. Without `replyTo`, the message is a non-blocking nudge delivered as a steer. With `replyTo`, it answers the matching blocking `need_decision` request.

### Validation

The extension must reject:

- empty names or tasks;
- a model outside the delegation pool;
- an invalid or model-unsupported thinking level, or one that conflicts with a thinking level pinned by the scoped model selector;
- an invalid or inaccessible working directory;
- a launch beyond the concurrency limit;
- calls made outside a Herdr-managed pane.

Tool arguments must be passed as process arguments, not interpolated into shell command strings.

## 6. Configuration and model routing

### Configuration

The extension reads JSON configuration using Pi's normal global/project precedence:

1. Built-in defaults.
2. `~/.pi/agent/subagent.json` global values.
3. `<cwd>/.pi/subagent.json` project values, only when `ctx.isProjectTrusted()` is true.

Project values override global values by key. Unknown fields, invalid JSON, and invalid values are rejected.

```json
{
  "routingMode": "cost",
  "allowCrossProvider": true,
  "maxConcurrency": 8,
  "maxDepth": 2,
  "modelHints": {
    "openai-codex/gpt-5.6-luna": {
      "costTier": "low",
      "bestFor": ["bounded implementation", "tests"],
      "avoidFor": ["large architecture changes"]
    }
  }
}
```

Defaults are `routingMode: "overhead"`, `allowCrossProvider: true`, `maxConcurrency: 4`, `maxDepth: 1`, and no `modelHints`. `maxConcurrency` must be an integer from 1 through 16 and limits concurrent direct children per parent session. `maxDepth` must be an integer from 1 through 8, with the root at depth 0. Unknown fields, invalid JSON, and invalid values are rejected.

`modelHints` is optional. Its keys must be exact provider-qualified selectors in the form `provider/model` or `provider/model:thinking`; values may contain only `costTier` (`free`, `low`, `medium`, or `high`), `bestFor`, and `avoidFor`. The latter two must be arrays of non-empty strings. Hints are merged by selector and then by field: defaults, global configuration, and trusted project configuration are applied in that order, with project fields overriding global fields without discarding other fields for the same selector. Untrusted project configuration is ignored as a whole, as with the other settings.

### Pool construction

At session start, the extension builds the delegation pool from Pi's scoped models:

1. Read `ctx.scopedModels`.
2. If `allowCrossProvider` is `true`, keep every scoped model regardless of provider.
3. Otherwise keep only models with the same provider as `ctx.model`.
4. If no scoped models remain, expose only the active parent model without pinning its current thinking level.
5. Preserve any thinking level explicitly pinned by a scoped model selector.

### Prompt exposure

The `subagent` tool description and prompt guidance must include:

- exact permitted model identifiers;
- each model's supported thinking levels from Pi's model metadata;
- instruction to select the lowest supported thinking level adequate for each delegated task;
- available cost metadata where Pi provides it;
- configured `bestFor` and `avoidFor` hints;
- configured `costTier` only when Pi does not provide non-zero input/output pricing;
- the active routing mode and rules below.

### Routing mode

`routingMode` controls when the parent should delegate:

- `overhead` (default): delegate only when parallelism or independent expertise outweighs startup and coordination overhead;
- `cost`: delegate serially only when a cheaper child can own a substantial bounded task end-to-end; do small cohesive changes directly when they need only one investigation, edit, and verification pass.

### Routing rules for the parent

The parent should:

- choose the cheapest model likely to complete the assignment correctly;
- choose the lowest supported child thinking level shown for that model: `off`/`minimal` for mechanical lookups, `low` for bounded repository analysis, routine implementation, tests, and summaries, and `medium`/`high` for complex planning, architecture, security-sensitive work, ambiguous debugging, or cross-cutting reasoning;
- use faster models for bounded search, mapping, mechanical work, test execution, and summarisation;
- use stronger models for architecture, ambiguous debugging, security-sensitive work, and independent final review;
- follow the active routing mode when deciding whether to delegate;
- delegate only work removed from the parent's own plan;
- after launch, continue only disjoint work or end the turn and wait for automatic completion;
- not inspect the same files, implement the same changes, or repeat the child's checks;
- after completion, review the result and run one verification pass, retracing only when the child reports a blocker or the review finds a problem;
- launch independent tasks together where this improves latency or quality;
- avoid concurrent writers in one checkout unless their file sets are explicitly disjoint;
- include scope, constraints, expected output, and verification requirements in every task;
- never poll for completion.

These are model instructions, not enforcement boundaries. Model and tool allowlists remain enforced by the extension.

## 7. Child task contract

The parent-generated `task` is the child's role and assignment. It should be understandable without access to the parent conversation.

A strong task normally states:

1. objective;
2. relevant context;
3. allowed scope;
4. constraints;
5. expected output;
6. required verification.

The extension adds only a small operational suffix:

> Work autonomously on this assignment. Stay within the granted capabilities. Use contact_supervisor only for a blocking decision or a meaningful plan-changing update. Delegate only when the subagent tool is available and its routing guidance says delegation is worthwhile. Your final response must report the result, supporting evidence, and any unresolved blocker in at most 800 words.

`contact_supervisor` supports two reasons:

- `progress_update`: sends a meaningful plan-changing discovery to the parent and returns immediately;
- `need_decision`: sends a blocking question and waits until the parent answers it with `subagent_message.replyTo`.

Routine narration and completion continue through the normal final child response.

No role-specific system prompt is added. The child otherwise receives Pi's standard prompt and normal trusted project context for its working directory. Read-only intent is expressed in the task; version one does not claim to sandbox the shell.

## 8. Launch lifecycle

### Preconditions

Before creating a pane, the extension verifies:

- `HERDR_ENV=1`;
- the `herdr` executable is available;
- the parent has `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID`;
- the Pi Herdr integration is installed, locatable, and current enough to report agent state and session identity.

### Sequence

1. Validate the tool input and reserve a concurrency slot.
2. Generate a unique delegation ID and Herdr-safe child agent name.
3. Open a private local socket for this parent-child relationship.
4. Create a child pane in the parent's current tab without changing focus, passing the socket path and child identity through its environment.
5. Start `pi` through `herdr agent start`, passing:
   - the selected model and parent-chosen thinking level;
   - the fixed child tool allowlist;
   - the parent's scoped delegation model pool;
   - child working directory and inherited root/depth metadata;
   - `--no-extensions` plus the explicit Herdr Pi integration, child messaging extension, and subagent extension;
   - a persistent child session.
6. Read the child session path reported by Herdr.
7. Record the current child-session entry count.
8. Report the relationship metadata from section 9.
9. Start `herdr agent prompt --wait` in a background watcher with the generated task.
10. Return a launch acknowledgement to the parent model.
11. Relay progress updates and decision requests over the private socket while the child runs.
12. When Herdr reports settlement, read new entries from the child Pi session.
13. Deliver the child's final assistant response to the parent using a custom Pi message with `triggerTurn: true` and `deliverAs: "steer"`.
14. Close the child pane and socket, then release the concurrency slot after the result is queued for the parent.

If launch fails after pane creation, the extension closes only the pane it created.

## 9. Herdr relationship metadata

The Pi extension reports display-only pane metadata using source `pi:subagent`.

| Token | Parent value | Child value |
|---|---|---|
| `delegation_id` | Existing value when the parent is delegated; absent on the root. | Unique delegation ID. |
| `delegation_parent` | Existing value when the parent is delegated; absent on the root. | Direct parent pane ID. |
| `delegation_root` | Root pane ID. | Inherited root pane ID. |
| `delegation_depth` | Current parent depth. | Parent depth plus one. |
| `delegation_label` | Existing parent label or root session/project label. | Tool-call `name`. |
| `delegation_model` | Parent model. | Child model. |
| `delegation_thinking` | Existing value when delegated; absent on the root. | Parent-selected child thinking level. |

The child pane title and `display_agent` should be set to its task label. Semantic state remains owned by the installed Herdr Pi integration.

Metadata values must respect Herdr's length and character limits. No TTL is used while the pane exists.

## 10. Asynchronous results

### Launch acknowledgement

The immediate tool result includes:

- delegation ID;
- child name;
- pane ID;
- model and thinking level;
- session path;
- status `started`.

It explicitly tells the parent that completion will arrive automatically, must not be polled, and must not be duplicated; the parent should continue only disjoint work or end the turn.

### Completion message

A completed result contains:

- delegation ID and child name;
- original task;
- model;
- elapsed time;
- child session path;
- final assistant text;
- terminal status.

Model-visible output is capped at Pi's normal tool-output limits. The complete result remains available in the child session.

### Child decision request

When a child calls `contact_supervisor` with `need_decision`:

- send a parent steer message containing the child ID, question, and request ID;
- keep the child tool call and watcher alive;
- accept the answer only through `subagent_message` with the matching `replyTo`;
- return the answer as the child tool result so work continues in the same turn.

### Blocked child

When Herdr independently reports `blocked`:

- send one parent steer message identifying the child and pane;
- keep the watcher alive;
- do not treat the run as complete;
- rely on the user to interact with the visible child pane;
- deliver the normal result after the child next settles.

Repeated unchanged blocked notifications must be suppressed.

### Failure

Failures include:

- Herdr launch or prompt errors;
- child process exit;
- missing or unreadable session output;
- provider/model failure recorded in the child session.

The parent receives a steer message containing the error, child identifiers, and session path when available.

## 11. Concurrency and workspace safety

- Maximum concurrent direct children is configured by `maxConcurrency` and defaults to **4**.
- `maxConcurrency` accepts only integers from **1** through **16**.
- The concurrency limit applies per parent Pi extension instance, not across the whole tree.
- Maximum delegation depth is configured by `maxDepth`, defaults to **1**, and accepts integers from **1** through **8**.
- The root is depth 0. Sessions at `maxDepth` have `subagent` and `subagent_message` removed from their active tools, and execution checks enforce the same boundary.
- Independent children may run concurrently.
- The parent is instructed not to launch overlapping writers in one checkout.
- The extension does not infer file ownership or serialize writes in version one.
- Worktree-based parallel writers are deferred to a later version.

## 12. Shutdown and cleanup

- Pi `session_shutdown` cancels local background watchers.
- Parent shutdown does not kill or close already-running children.
- The extension closes a child pane after completion or terminal failure, once its session result has been captured.
- Launch failures close any pane created by that launch.
- Child session files remain available after their panes close.
- Reattaching watchers after parent restart is out of scope for version one.

## 13. Security

- Project context and extensions run with the user's permissions.
- Prompt instructions are not a sandbox.
- Model, fixed tool allowlist, concurrency, and depth restrictions are enforced by the extension.
- The `subagent` tool is removed at `maxDepth`, but this is not a process sandbox: `bash` can still launch other programs.
- Each child gets a unique local socket path; Unix sockets are owner-only and are removed during cleanup.
- The messaging channel addresses only the known parent-child relationship and provides no peer discovery.
- `cwd` is resolved and validated before use.
- No shell interpolation is used for task text, names, paths, or model IDs.
- Cross-provider delegation is enabled by default and may transfer task and project data to another configured provider. Set `allowCrossProvider` to `false` to restrict delegation to the parent's provider.
- Stronger isolation requires an existing container or VM boundary and is not provided by this extension.

## 14. Observability

The extension should log only operational identifiers and errors. It must not duplicate Herdr's live status UI.

Useful identifiers:

- parent Pi session ID;
- parent pane ID;
- delegation ID;
- child pane ID;
- child Pi session path;
- selected model;
- timestamps and elapsed time.

Task and result bodies should not be written to additional logs because they already exist in Pi sessions.

## 15. Acceptance criteria

- [ ] AC-1: Pi exposes one `subagent` tool without reading agent definition files.
- [ ] AC-2: Every launch requires a model from the advertised delegation pool.
- [ ] AC-3: A child starts in a non-focused Herdr pane.
- [ ] AC-4: Herdr reports the child as a managed Pi agent.
- [ ] AC-5: Parent-child metadata follows section 9 exactly.
- [ ] AC-6: The tool returns before the child task completes.
- [ ] AC-7: Completion triggers a new parent turn without polling.
- [ ] AC-8: Final output comes from the child Pi session.
- [ ] AC-9: Children below `maxDepth` can delegate; children at the limit cannot.
- [ ] AC-10: More than the configured `maxConcurrency` concurrent direct children are rejected.
- [ ] AC-11: Launch failure does not leave a newly-created empty pane.
- [ ] AC-12: A settled child's pane closes after result delivery.
- [ ] AC-13: Parent shutdown leaves running child panes intact.
- [ ] AC-14: Configuration follows defaults < global `subagent.json` < trusted project `subagent.json` precedence.
- [ ] AC-15: Routing defaults to `overhead`; `routingMode: "cost"` injects cost-minimizing delegation guidance.
- [ ] AC-16: Valid per-model hints are injected compactly, with Pi pricing taking precedence over configured cost tiers.
- [ ] AC-17: Every launch requires a parent-selected thinking level, passes it to child Pi, and rejects levels unsupported by the model or conflicting with scoped thinking-level pins.
- [ ] AC-18: A running child can send a non-blocking progress update to its parent.
- [ ] AC-19: A child's blocking decision request stays alive until its parent answers the matching request ID.
- [ ] AC-20: A parent can steer a live child with `subagent_message` without restarting it.

## 16. Deferred decisions

Revisit only after the basic delegation experiment is evaluated:

- per-provider delegation allowlists;
- shared tree-wide child, token, or cost budgets;
- general peer discovery and brokered inter-session messaging;
- durable or restart-recoverable parent-child mailboxes;
- structured interviews and attachments;
- per-task tool profiles;
- worktree creation for parallel writers;
- recovery of watchers after parent restart;
- model aliases such as `fast` and `strong` if direct model selection proves unreliable.

## 17. References

- [OpenAI latest model guide: subagent delegation](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#gpt-6-astra-subagent-delegation)
- [DeepSeek V4 Pro with Pi Coding Agent](https://deepseekv4pro.com/guides/deepseek-pi-coding-agent)
