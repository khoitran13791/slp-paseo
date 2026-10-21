# Paseo capabilities — verified vs assumed (2026-10-21)

Sources: local CLI `/Applications/Paseo.app/Contents/Resources/bin/paseo` v0.10.3 (`--help` of every subcommand), `~/.paseo/config.json` (keys only), live docs fetched 2026-10-21 from https://paseo.sh/llms.txt (orchestration, orchestration-workflows, mcp, schedules, plugins, plugins/reference, agent-profiles, skills, sdk, hub). No live daemon test: local daemon is **stopped** (last ran 2026-10-05).

## Local state
- Paseo 0.10.3 installed; CLI not on PATH (only inside the app bundle).
- `daemon.mcp.injectIntoAgents = true`; `pluginsEnabled` absent → plugins OFF. Enabling needs explicit user consent (trusted, unsandboxed code).
- One agent profile ("Claude — General"). `~/.paseo/agents` has 1 entry (a setup check, 2026-10-05) → user has barely run work through Paseo yet.

## Verified (docs + CLI)
- **No "room" concept** in current Paseo (0 hits in docs/CLI). Units are: project → workspace (local or git worktree) → agents (with parent/subagent links) + terminals + scripts. "Room shared state" must be built by us.
- **Agent ↔ agent messaging:** any agent can `send_agent_prompt` / `paseo send <id>` to any agent on the same host by ID, incl. agents it did not launch, across workspaces. Agent-originated sends default to *steering a running turn* (interrupt fallback); override with `activeTurnBehavior` / `--behavior steer|interrupt`.
- **Reading other agents:** MCP `get_agent_status`, `get_agent_activity` (curated timeline), `list_agents`; CLI `paseo ls --json [--label k=v] [-g]`, `inspect`, `logs [-f] [--filter tools|text|errors|permissions]`, `wait`. External (non-Paseo) clients can use CLI / TS SDK `@getpaseo/client` (ws://127.0.0.1:6767/ws) / MCP.
- **Notifications:** a parent agent gets finish/error/permission notifications for its subagents (`notifyOnFinish`, default true). Non-parents do not — would need a plugin.
- **Labels:** `paseo run --label k=v`, `agent update --label`, `ls --label` filter. **Structured output:** `paseo run --output-schema <json schema>`.
- **Heartbeat:** recurring cron prompt into the *calling* agent only ("this agent"); MCP create/delete only, CLI can update cron. **Schedule:** cron → fresh agent each run; full CRUD; archive-on-finish default true (only changeable in app).
- **Per-role tool limits:** custom provider IDs (`agents.providers.<id>.extends: "codex"`) with `paseoTools.disabledTools: [...]` or `enabled:false`. Docs: *not a security boundary* if agent has a shell (it can call the CLI).
- **Plugin server hooks** (`index.server.ts`, run on daemon even with no app open):
  - Events: `agent.created/closed/turn_started/turn_ended/permission_requested/permission_resolved/archived`, `workspace.created/archived`. Delivery is **live, best-effort, no replay/persistence/retry**; 30 s handler timeout.
  - `agent.turn_ended` → read tail of timeline (`paseo.agents.ref(id).timeline.refetch`) and `agent.send(...)` a follow-up (docs example: auto "Try again" on "out of credits").
  - `agent.permission_requested` → `respondToPermission(allow|deny)`; kinds: tool, plan, question, mode, other. Only fires when the provider mode actually asks.
  - Before hooks: `agent.create` can rewrite `systemPrompt`, `mcpServers`, `toolPolicy`, `providerOptions` (e.g. Codex `sandbox_mode: read-only|workspace-write`, `approval_policy`), model/mode; **cannot change cwd**. `agent.session_open` → env only. `workspace.create` → force worktree isolation.
  - Agent payload has `id, workspaceId, parentAgentId, provider, cwd, title` (no labels).
  - Plugin can append its own rows to any agent timeline (in-memory, lost on daemon restart), add workspace panels / sidebar surfaces / slash commands / Command Center items, and persist host-scoped JSON settings documents (atomic, revisioned, survive restart).
- **Hub** (hosted or self-host): triggers from GitHub/Slack/Discord/Linear start agents; outputs to those channels. Not needed for pilot.

## Assumed / not verified
- Whether Claude Code provider in Paseo surfaces Bash permission requests to plugins in a non-bypass mode (needed for "deny `paseo send` from Peers"). Codex read-only sandbox is the stronger, documented lever.
- Whether a plugin can see an agent's *labels* in hooks (payload omits them) → role must be keyed by custom provider ID or title/env.
- Steering semantics with Claude Code provider (steer vs interrupt) not tested.
- Behaviour of heartbeats while the target agent is mid-turn or after a usage-limit failure.
- Push notification to the human's phone on a pending `question` permission (mobile app exists; not verified).
