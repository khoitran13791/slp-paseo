# SLP on Paseo — usage guide

SLP is a Paseo plugin that runs a feature with a small team of agents. You talk to one agent, the **Supervisor**:

1. The Supervisor brainstorms the feature with you.
2. A **Lead** turns the brainstorm into a spec and a plan.
3. **Peer impl** agents (Claude) write the code, one task at a time, each in its own worktree.
4. A **Peer review** agent (Codex) reviews each task.

You make three kinds of decisions: the answers in the brainstorm, the spec approval, and the ship approval. Merging into `main` stays with you.

Design and rationale: [`docs/superpowers/specs/2026-10-21-slp-paseo-design.md`](docs/superpowers/specs/2026-10-21-slp-paseo-design.md). Live test reports: [`docs/research/`](docs/research/).

> **Status:** ready for a pilot on your own repo, with you watching the first run. So far the live tests cover only features with a single task. They have not yet covered several tasks in one feature, pushing to a real remote with a PR, or the challenge/hypothesis path.

## Requirements

| What | Version / state | Why |
|---|---|---|
| macOS + Paseo desktop | 0.12.0 or later (`paseo-plugin.json`) | The plugin runs inside the local daemon |
| Claude Code CLI | tested with 2.1.308 | Supervisor, Lead, Peer impl |
| Superpowers plugin for Claude Code | installed in Claude Code's plugin cache | The Claude roles load it. If it is missing, they start without it and the plugin logs a warning (`runtime.claudePluginDir` points to another copy) |
| Codex CLI | 0.163 or later, logged in (`~/.codex/auth.json`) | The reviewer, and the sandbox that runs `verify` |
| Node | 22, first on `PATH` in a login shell | Plugin and verify commands. If nvm and Homebrew both install Node, check that nvm comes first in `~/.zshenv` **and** `~/.zprofile` |
| git | any recent version | Worktrees, commits, merges |
| `gh` | logged in (`gh auth status`) | Only when `ship.openPr` is `true` |

The Paseo CLI is not on `PATH` by default:

```bash
PASEO=/Applications/Paseo.app/Contents/Resources/bin/paseo
```

The repo you run SLP on must:
- be your own code with no content from outside, such as issues or PRs from strangers or vendored third-party code. The reviewer setup is accepted for that case only (spec §13);
- have at least one commit on the base branch at the remote (default `origin/main`). An empty repo is fine, but a repo with no commits is not, because every worktree is cut from that branch. Starting from scratch works: the first task can lay out the project;
- have no git config that runs commands (fsmonitor, filter or diff drivers). SLP refuses to start agents in such a repo and says why in the plugin logs.

## 1. Install (once)

**Enable plugins.** Plugins are trusted, unsandboxed code: backend plugin code can access your daemon machine, including files, processes, credentials and network services. Turn them on in **Settings → Plugins → Enable plugins**, or set `"pluginsEnabled": true` in `~/.paseo/config.json`.

**Add the 4 providers and 4 agent profiles.** Back up `~/.paseo/config.json` first, then run:

```bash
cp ~/.paseo/config.json ~/.paseo/config.json.bak-before-slp
python3 -I - <<'EOF'
import json, os, random, string, time
p = os.path.expanduser("~/.paseo/config.json"); c = json.load(open(p))
c["pluginsEnabled"] = True
off = {"enabled": False}
prov = c.setdefault("agents", {}).setdefault("providers", {})
prov["slp-supervisor"] = {"extends": "claude", "label": "SLP Supervisor", "paseoTools": off}
prov["slp-lead"] = {"extends": "claude", "label": "SLP Lead", "paseoTools": off}
prov["slp-peer-impl"] = {"extends": "claude", "label": "SLP Peer impl", "paseoTools": off}
prov["slp-peer-review"] = {"extends": "codex", "label": "SLP Peer review", "paseoTools": off}
pid = lambda: "agent_profile_%s_%s" % (format(int(time.time() * 1000), "x"), "".join(random.choices(string.ascii_lowercase + string.digits, k=11)))
mine = [
    {"name": "Supervisor", "provider": "slp-supervisor", "model": "claude-opus-5-5", "modeId": "default", "thinkingOptionId": "high"},
    {"name": "Lead", "provider": "slp-lead", "model": "claude-opus-5-5", "modeId": "default", "thinkingOptionId": "xhigh"},
    {"name": "Peer impl", "provider": "slp-peer-impl", "model": "claude-sonnet-5-5", "modeId": "default", "thinkingOptionId": "high"},
    {"name": "Peer review", "provider": "slp-peer-review", "model": "gpt-6-astra", "modeId": "auto", "thinkingOptionId": "xhigh"},
]
d = c.setdefault("daemon", {})
d["agentProfiles"] = [x for x in d.get("agentProfiles", []) if not str(x.get("provider", "")).startswith("slp-")] + [{"id": pid(), **x} for x in mine]
json.dump(c, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
EOF
$PASEO reload --json
```

`reload` should list `agents.providers`, `daemon.agentProfiles` and `pluginsEnabled` under `appliedPaths`. The Paseo tools stay off for every SLP role: they talk only through the plugin.

**Write `~/.slp/config.json`** (see [`docs/examples/slp-config.example.json`](docs/examples/slp-config.example.json)). The project name is a lowercase slug, and `repo` is the absolute path of your checkout:

```json
{
  "projects": {
    "my-app": { "repo": "/Users/you/Projects/my-app", "baseBranch": "origin/main", "verify": ["npm test"] }
  },
  "ship": { "remote": "origin", "openPr": true }
}
```

`verify` is the command that has to pass on the finished feature before it can ship. In an empty repo it cannot pass yet, which is fine: the feature's first tasks create what it runs.

**Install the plugin:**

```bash
cd ~/Documents/Projects/slp-paseo/plugin && npm install && npm run typecheck
$PASEO plugin install "$PWD"
$PASEO plugin ls          # slp should show "running"
```

The plugin reads `~/.slp/config.json` only when it starts. After you change that file, run `$PASEO plugin reload slp`.

### Settings you may want to change

All keys are optional except `projects`; defaults are in [`plugin/server/config.ts`](plugin/server/config.ts).

| Key | Default | Meaning |
|---|---|---|
| `projects.<name>.baseBranch` | `origin/main` | The branch features start from and the PR targets |
| `projects.<name>.verify` | (required) | Feature-level check before shipping; several commands run joined with `&&` |
| `ship.openPr` | `true` | `true`: push `feat/<slug>` and open a PR with `gh`. `false`: push only |
| `ship.remote` | `origin` | Where `feat/<slug>` is pushed |
| `watch.intervalMinutes` | `15` | How often the Supervisor gets a status pack |
| `limits.humanReminderMinutes` | `30` | When the Supervisor reminds you of a decision still waiting on you |
| `limits.verifyTimeoutSeconds` | `900` | Longest a single verify run may take |
| `models.allowed` | `[]` (any) | Models a plan may assign to a task |
| `sandbox.denyRead` | `["~/.slp", "~/.paseo"]` | Paths no SLP sandbox may read. Add more, such as `~/.ssh` or `~/.aws` |
| `sandbox.claudeAllowedDomains` | npm and PyPI registries | The only network domains the Claude roles' shell may reach |
| `flags.supervisorPlanApproval` | `true` | The Supervisor checks and approves the Lead's plan. If `false`, plans are approved automatically |

## 2. Run a feature

1. **Open the repo in Paseo** as a workspace (it gets the project's normal sidebar entry).
2. **Start the Supervisor:** new agent → model chip → **Profiles** → **Supervisor**. Use the profile, not the plain Claude model: SLP only takes over agents of the `slp-*` providers whose folder is inside a `repo` from your config.
3. **Say what you want**, in your own language. The Supervisor answers in the language of your latest message. The brief, spec and plan are always written in English.
4. **Brainstorm.** The Supervisor asks one question at a time, usually with options A/B/C. Answer with a letter or in your own words. For hard questions it may call the Lead in early, and a `[Lead] <slug>` workspace then appears in the sidebar.
5. **Approve the spec.** The Supervisor walks you through it: what it does, a table of example inputs and results, the decisions the Lead added, and the file path. To approve, send a short message that is only a yes: `duyệt`, `ok`, `yes`, `lgtm`. To ask for changes, say what to change.
6. **Let it work.** The Supervisor checks the Lead's plan. Then the Lead runs the tasks one at a time:
   - a Peer impl writes the code in its own worktree, with tests first;
   - the plugin commits its work and runs the task's verify;
   - a Codex reviewer checks the commit;
   - failed reviews go back for repair.

   Peers and reviewers run as background agents and do not crowd the sidebar.
7. **Ignore the watch packs.** Every `watch.intervalMinutes` the Supervisor tab gets a block that starts with `[SLP watch #N · <slug>] For the Supervisor; no action needed from you.` If something needs you, the Supervisor tells you in a normal message, and the pack shows `Waiting on human: …`.
8. **Approve the ship.** The Supervisor shows the ship package:
   - the summary;
   - the test results;
   - the review history;
   - an "On approval" line saying exactly what will happen: push `feat/<slug>`, plus a PR or not.

   Reply with the phrase it asks for (for example `ok ship`), alone in the message.
9. **Merge it yourself.** Review the PR, or the pushed branch, and merge it as you normally would.

### How approvals are checked

The plugin accepts an approval only if your **latest** message to that agent is a plain yes:
- It must contain no question mark and no negation ("chưa duyệt", "khoan", "don't ship", "wait").
- It must contain nothing other than approval words, filler words, a version number or the feature name.
- "ok, but explain the risks first" approves nothing.
- Send notes in a separate message *before* the yes, because a later message replaces an earlier approval.
- You can also approve the spec in the Lead's tab, and the Supervisor is told.

### Talking to the agents

- Talk to the **Supervisor**. You may also write to the Lead in its tab.
- Leave Peers and reviewers alone: they take instructions from the Lead.
- To change your mind midway, tell the Supervisor. If the goal itself changes, the feature is halted and the Supervisor brainstorms the new goal with you.
- A permission popup means an agent wants something outside its sandbox (for example reading a file outside its worktree). Approve it only if you understand the request.

## 3. Where things are

| What | Where |
|---|---|
| Brief, spec, plan versions | `~/.slp/<project>/features/<slug>/{brief,spec,plan}.vN.md` |
| Event log, digest, task reports | `~/.slp/<project>/features/<slug>/events.jsonl`, `digest.md`, `reports/` |
| Human messages SLP recorded | `~/.slp/<project>/project.jsonl` |
| Worktrees | `~/.slp-worktrees/<project>/`: `feat-<slug>` (Lead), `slp-<slug>-T<n>-<k>` (Peer) |
| Plugin output | `$PASEO plugin logs slp` |

The plugin removes Peer and reviewer worktrees when a task is accepted. The Lead's `feat-<slug>` worktree stays after shipping. Remove it with `git -C <repo> worktree remove ~/.slp-worktrees/<project>/feat-<slug>`; the branch stays.

## 4. Troubleshooting

| Symptom | Check |
|---|---|
| The Supervisor has no `slp_*` tools and behaves like plain Claude | It was not started from the **Supervisor** profile, its folder is not inside a configured `repo`, or the plugin is not running (`$PASEO plugin ls`, `$PASEO plugin logs slp`) |
| `SLP config invalid: …` in the logs | Fix `~/.slp/config.json`, then `$PASEO plugin reload slp` |
| "SLP will refuse to start agents here" | The repo's git config runs commands (fsmonitor, filter or diff driver). Remove them |
| Verify fails with "cannot verify: …" | The Codex sandbox runner failed. Check `codex --version` and `sandbox.runner` |
| Verify or tests use the wrong Node | The daemon's `PATH` comes from a login shell. Check that `zsh -lc 'node --version'` prints 22 |
| An approval is not accepted | Send a new message that is only the yes word, with nothing else in it |
| The app shows a stale card, timer or tab | **View → Reload** in the Paseo app |
| An agent needs a reload | ⌘K → **Reload agent** in the app. `paseo agent reload` cannot find agents in background workspaces |

## 5. Turning it off

```bash
$PASEO plugin disable slp      # keep it installed but stop it
$PASEO plugin remove slp       # uninstall
```

To undo the provider and profile changes, restore `~/.paseo/config.json.bak-before-slp` and run `$PASEO reload --json`. SLP's records stay in `~/.slp/` until you delete them.

## Security notes

- The plugin runs unsandboxed on your machine.
- The Claude roles' shell is sandboxed: no writes outside the worktree, network limited to `sandbox.claudeAllowedDomains`, and no reads of `sandbox.denyRead`. It **can** read the rest of `$HOME`. Add secrets folders to `denyRead`.
- The plugin leaves two kinds of files out of every commit: secret-looking files (`.env*`, `*.pem`, `*.key`, SSH keys, `*.p12`, `credentials.json`), and hook or agent-settings files (`.husky`, `.githooks`, the repo's `core.hooksPath`, `.claude`, `.codex`, `.mcp.json`, `paseo.json`). A Peer that changes only such files gets its report rejected.
- Check the diff before you approve a ship.
