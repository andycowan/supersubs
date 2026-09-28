# SuperSubs

SuperSubs is a Pi extension that delegates coding tasks to autonomous subagents in Herdr panes. It supports configurable model routing, parallel work, and parent–child messaging.

## Installation

Requires Pi, Herdr, and Node.js 22.18 or newer. Install Herdr's Pi integration, then install SuperSubs as a Pi package:

```sh
herdr integration install pi
pi install git:github.com/andycowan/supersubs
```

Start Pi in a Herdr-managed pane to use `subagent`. Run `pi list` to confirm the package is installed. To try a local checkout instead, run `pi install /path/to/supersubs`.

The subagent extension is configured with `supersubs.json`.

## Configuration locations

Configuration is merged in this order:

1. Built-in defaults.
2. Global: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/supersubs.json`.
3. Trusted project: `<project>/.pi/supersubs.json`.

Later values override earlier ones. Project configuration is ignored unless Pi trusts the project. Unknown fields, invalid JSON, and invalid values stop configuration loading with an error.

Run `/reload` or restart Pi after changing configuration.

## Example

```json
{
  "routingMode": "cost",
  "modelRouter": "jev",
  "jevApiKey": "...",
  "allowCrossProvider": true,
  "maxConcurrency": 8,
  "maxDepth": 2,
  "childExtensions": ["npm:@arhen/pi-core-tps-stats"],
  "modelHints": {
    "opencode-go/omen-alpha": {
      "costTier": "low",
      "bestFor": ["bounded repository analysis", "routine implementation", "tests"],
      "avoidFor": ["security-sensitive architecture"]
    }
  }
}
```

## Settings

### `routingMode`

Controls when the parent should delegate.

| Value | Behavior |
|---|---|
| `"overhead"` | Delegate only when parallelism or independent expertise outweighs startup and coordination overhead. |
| `"cost"` | Prefer a cheaper child for substantial bounded work; keep small cohesive changes in the parent. |

Default: `"overhead"`.

### `modelRouter`

Controls who chooses the child model.

| Value | Behavior |
|---|---|
| `"parent"` | The parent model must choose an exact selector from the delegation pool. |
| `"jev"` | Jev chooses the model. Any model supplied by the parent is ignored. |

Default: `"parent"`.

Jev routing requires `jevApiKey` in `supersubs.json`. Store it in the global `${PI_CODING_AGENT_DIR:-~/.pi/agent}/supersubs.json` rather than a project file so it is not committed:

```json
{
  "modelRouter": "jev",
  "jevApiKey": "..."
}
```

Routing is authoritative: a missing key, timeout, HTTP error, or invalid response aborts the delegation rather than falling back to the parent's model choice. The parent still chooses the thinking level; SuperSubs filters out models that do not support it before asking Jev.

Jev receives the delegated task plus compact candidate metadata: selector, price rank, supported thinking levels, and configured `bestFor`/`avoidFor` hints. Tasks may contain sensitive information, so enable Jev routing only when sending task text to TypeSafe is acceptable.

Jev asks separately for the best capability fit and the cheapest adequate fit. Tasks that directly change authentication, authorization, credentials, encryption, payments, privacy boundaries, or destructive data operations use the capability choice; other tasks use the economy choice.

Run `/reload` or restart Pi after changing the configuration.

### `allowCrossProvider`

When `true`, the delegation pool may include scoped models from providers other than the parent's provider. When `false`, only same-provider models are available.

Default: `true`.

### `maxConcurrency`

Maximum concurrent direct children for each parent session.

- Minimum: `1`
- Maximum: `16`
- Default: `4`

This is a per-parent limit, not a tree-wide total.

### `maxDepth`

Maximum delegation depth. The root session is depth `0`; its direct children are depth `1`.

- Minimum: `1`
- Maximum: `8`
- Default: `1`

Children below the limit can spawn their own children. At the limit, `subagent` and `subagent_message` are removed from the child's active tools.

### `childExtensions`

Optional Pi extension sources loaded explicitly in child sessions, using the same package or path syntax as Pi's `--extension` option. Ordinary extension discovery remains disabled.

```json
{
  "childExtensions": ["npm:@arhen/pi-core-tps-stats"]
}
```

Default: `[]`.

### `modelHints`

Optional routing guidance keyed by an exact model selector:

```text
provider/model
provider/model:thinking
```

Each model hint supports:

| Field | Values | Meaning |
|---|---|---|
| `costTier` | `"free"`, `"low"`, `"medium"`, `"high"` | Fallback cost classification when Pi has no non-zero model pricing. |
| `bestFor` | Array of non-empty strings | Tasks suited to the model. |
| `avoidFor` | Array of non-empty strings | Tasks that should use another model. |

Hints guide both parent routing and Jev routing. Without capability hints, Jev only sees the selector, pricing, and supported thinking levels, which is usually not enough to distinguish private or newly released models reliably.

Hints merge by selector and then by field. A project can override one field without replacing the model's other global hints:

Global:

```json
{
  "modelHints": {
    "provider/model": {
      "costTier": "low",
      "bestFor": ["tests"],
      "avoidFor": ["architecture"]
    }
  }
}
```

Project override:

```json
{
  "modelHints": {
    "provider/model": {
      "avoidFor": ["security-sensitive work"]
    }
  }
}
```

Effective hint:

```json
{
  "costTier": "low",
  "bestFor": ["tests"],
  "avoidFor": ["security-sensitive work"]
}
```

## Parent-child messaging

Each running child has a private local channel to its direct parent. On Unix, the channel is an owner-only socket removed when the child finishes. Messages are relationship-scoped: there is no broker, peer discovery, mailbox, broadcast, or communication with completed children.

### Child to parent: `contact_supervisor`

Children receive the `contact_supervisor` tool with two reasons.

#### Progress update

```ts
contact_supervisor({
  reason: "progress_update",
  message: "The shared retry wrapper is the root cause; I am fixing it there."
})
```

This sends a non-blocking update and returns immediately. Use it only when a discovery changes the parent's plan—not for routine narration or completion. Normal completion is delivered through the child's final response.

#### Blocking decision

```ts
contact_supervisor({
  reason: "need_decision",
  message: "Should this preserve the deprecated response field?"
})
```

This keeps the child tool call open until the direct parent answers. The parent receives the question with a delegation ID and request ID.

### Parent to child: `subagent_message`

The parent can send new guidance to a running direct child:

```ts
subagent_message({
  id: "<delegation-id>",
  message: "Also verify the migration rollback path."
})
```

The message is steered into the child's current work. It should add new guidance rather than duplicate the original assignment.

To answer a blocking decision request, include its request ID:

```ts
subagent_message({
  id: "<delegation-id>",
  replyTo: "<request-id>",
  message: "Preserve it for this release and mark it deprecated."
})
```

The answer becomes the result of the child's waiting `contact_supervisor` call, allowing the child to continue in the same turn. A parent can message only its own currently running direct children; nested children communicate through their immediate parent.
