# Legible — Design Document

AI-assisted GitHub PR review tool. The current implementation is a Node daemon + browser UI;
the target is a standalone Rust daemon + desktop window, with a future VS Code extension as
another client. Existing implementation details below remain the baseline until migrated.

---

## 1. Overview

### Goals

1. **Help the reviewer understand the PR.** This is the primary goal.
2. **Surface candidate change requests, then groom them through conversation before submitting.** The human makes the judgment call.

### Non-goals

- Not an automated review bot. The AI never posts comments to the PR on its own.
- Not a code editor. If you need to fix something mid-review, go to your editor.
- Not a SaaS. Every user runs it on their own machine with their own credentials.

### Positioning

Three adjacent categories exist:

| Category | Examples | How it differs |
|---|---|---|
| Automated review bots | CodeRabbit, Greptile, Copilot code review | Replace the reviewer. Opposite direction |
| Agent-output review tools | difit, diffity, diffx, codiff | Target is local changes. No GitHub PR involved |
| PR review clients | Reviewable, Graphite, diff.reviews | Not AI-native (former) or closest competitor (diff.reviews) |

Legible's differentiator is the **structure where AI finds issues and the human filters and refines them.** Bots fail at exactly one thing: they detect, but cannot judge whether a finding is excessive in context. Legible sidesteps that by design rather than trying to solve it.

A consequence worth internalizing: **recall matters more than precision.** Since a human filters everything anyway, the agent should surface borderline items with its reasoning rather than staying conservative. Write the prompts accordingly.

---

## 2. Architecture

Target architecture:

```
[Desktop window: React in a WebView] ─┐
[Browser UI, including SSH forwarding] ├─ client boundary ─ [Legible daemon (Rust)]
[Future VS Code extension] ────────────┘                        │
                                                                ├─ Git worktrees + GitHub API
                                                                ├─ Claude CLI adapter
                                                                ├─ Codex app-server adapter
                                                                └─ per-session MCP endpoints
```

The desktop window is an independent application, not an embedded browser tab. Its shell
starts or attaches to a separately running daemon; closing a window does not end review sessions.
Keep the daemon's domain model, persistence, GitHub writes, and agent subprocesses out of every
UI host. The desktop shell framework is not selected yet. Reuse the existing React review UI in
an embedded WebView rather than rewriting the diff viewer in a native widget toolkit.

### Principles

- **One daemon per machine.** It holds multiple repos and multiple PRs.
- **Review sessions are decoupled from client lifetime.** Close the desktop window, browser tab,
  or future VS Code view; the session survives and can be reopened.
- **The daemon is the sole GitHub/agent credential boundary.** No GitHub token ever reaches an
  agent process or UI client.
- **Clients share a versioned daemon contract.** A desktop, browser, or editor client must not
  own a second implementation of review, worktree, or submission logic.

### Stack

| Layer | Current implementation | Target |
|---|---|---|
| Daemon | TypeScript (Node) | Standalone Rust process; preserve the observable HTTP/WebSocket and state contracts during migration |
| Review UI | Vite + React browser SPA | Reuse React + CodeMirror in the desktop WebView; keep browser access and make host integration replaceable |
| GitHub | Octokit (REST + GraphQL) | Daemon-owned GitHub API client; `gh` remains an authentication broker, not a review API |
| Agents | Claude Agent SDK; Codex app-server | Direct Rust clients of the locally installed official Claude CLI and Codex app-server |

Node remains a development/build dependency for the React UI, not a required Legible daemon
runtime. Neither agent SDK nor a community Rust wrapper is part of the target daemon. Agent
executables, `git`, and `gh` remain external prerequisites for the operations that use them;
whether to bundle any of those tools is a later distribution decision. The current npm workspace
and commands remain valid for the Node baseline during migration; npm continues to build the
React UI after the Rust daemon replaces that baseline.

### Repository workspaces

Use a root Cargo workspace for Rust packages, alongside the npm workspace for React and future
TypeScript clients. Cargo owns Rust dependency resolution, builds, tests, formatting, and linting;
npm owns the frontend tooling. Cargo does not replace the JavaScript package manager.

Target layout, introduced incrementally:

```
Cargo.toml                 root Rust workspace
Cargo.lock                 locked Rust dependencies
crates/protocol/           normalized wire models shared by Rust clients and daemon
crates/daemon/             daemon services, CLI entry points, and direct agent adapters
apps/desktop/              future Rust desktop-shell workspace member
apps/web/                  existing React UI, built with npm
packages/protocol/         TypeScript bindings for the shared wire contract
apps/daemon/               Node comparison implementation, retained during migration
```

The daemon crate must build and run independently of the desktop member and its GUI dependencies.
The desktop member is added when its framework is selected. A future VS Code extension belongs
to the npm workspace and connects to the daemon contract; it does not become a Cargo member.

Keep one authoritative wire contract. During migration, the existing TypeScript types and recorded
fixtures define compatibility. Once ported, the Rust protocol crate owns the serializable models
and produces the TypeScript bindings through a shared schema/generation step; do not maintain two
independent copies of the same HTTP and event types. Select the generator when porting the contract
and verify its output against the existing payload fixtures.

Add Cargo checks to CI alongside the existing npm checks as soon as the first Rust crates exist:
`cargo check --workspace`, `cargo test --workspace`, `cargo fmt --all -- --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`. Keep Rust toolchain settings and common
dependency versions in the workspace configuration. Build output belongs in Cargo's `target/`;
frontend output remains in its workspace's `dist/`.

### Startup and CLI lifecycle

```
legible              # start/attach, register a supported cwd repo, open home
legible pr 123       # reopen a review, or prefill the web PR selector
legible add <path>   # register a repo only; relative paths use caller cwd
legible status       # inspect without starting a daemon or exposing a token
legible stop         # stop an idle daemon; refuse while work is active
```

The CLI starts a detached background daemon if absent; otherwise it attaches. **Must be idempotent.**
Production startup claims the loopback HTTP listener (127.0.0.1:7777) and private Unix control socket
at `$XDG_STATE_HOME/legible/daemon.sock` (fallback `~/.local/state/legible/daemon.sock`) before any
session/configuration recovery or worktree sweep. The port is the atomic startup guard; only its
owner may reclaim a verified stale socket. A live control socket also prevents a second port from
opening the same state directory. Never remove regular files, symlinks, or another user's socket.
All ordinary HTTP and WebSocket traffic is gated until ready and again during shutdown.

The versioned, bounded Unix control protocol supports only status, connect, and stop. Status is
secret-free; connect hands the current bootstrap token to the same-user CLI without persisting it.
Instance IDs prevent commands targeting an outdated daemon. CLI repository and session operations
use the existing authenticated HTTP API, not a second implementation of domain logic. Preserve the
separate MCP credential boundary. The state directory and socket are private (0700/0600).

Local interactive CLI runs open the browser; SSH/CI/non-interactive runs print the URL only.
`--open` and `--no-open` override the default. Browser-open failure is non-fatal. New PR links only
prefill the web selector: settings and new-session creation stay in the UI. Existing reviews retain
their pinned commits/settings and reopen their review or receipt. Opening never starts an agent.
Plain `legible` outside a supported checkout warns but still opens home; `add` and `pr` fail.

Stop atomically gates new mutations and refuses active mutation requests, Git operations, or agent
turns. On an idle stop, finish agent shutdown/configuration restoration and persist chat snapshots
before releasing the listener. Shutdown errors must reach the CLI after resources are closed.
SIGINT/SIGTERM share this cleanup path; interrupted turns retain their recovery requests. Never kill
by a saved PID or automatically restart a version mismatch. Startup/stop CLI waits are bounded at
30 seconds, without forced termination on timeout. Background logs are private and contain no
bootstrap URLs or tokens. Foreground npm/watch entry points use the same ownership rules.

9B supports Linux, macOS, and WSL. Native Windows, npm publishing, service/autostart installation,
automatic SSH tunnels, folder picking, and non-loopback binding remain follow-up work.

Preflight on startup checks presence, version, and authentication of `git`, `gh`, `claude`, and
`codex`. Degraded status stays visible, but gating is operation-specific: registration needs Git,
PR listing needs GitHub auth, PR preparation needs Git and GitHub auth, and AI turns need only the
selected agent. An unused agent being absent must not block the other backend.

---

## 3. Data Model

```ts
type Repo = {
  id: string              // owner/name from origin. Not a path
  owner: string
  name: string
  checkouts: string[]     // local clone paths
  primaryCheckout: string
}

type ReviewSession = {
  id: string
  repoId: string
  prNumber: number
  headSha: string         // pinned at session start
  baseSha: string         // merge-base
  worktreePath: string
  config: ReviewConfig
  comments: DraftComment[]
  createdAt: string
}

type DraftComment = {
  id: string
  path: string
  line: number            // anchor. Left or right file line depending on side
  side: 'LEFT' | 'RIGHT'
  startLine?: number      // multi-line
  startSide?: 'LEFT' | 'RIGHT'
  body: string
  origin: AgentBackendKind | 'human'
  createdAt: string
}

enum AgentBackendKind {
  Claude = 'claude',
  Codex = 'codex',
}

type AgentSpec = {
  backend: AgentBackendKind
  model?: string          // free-form. Do not validate
  effort?: string         // backend-native value. Do not normalize
  shell: 'none' | 'git' | 'broad'
  network: 'off' | 'fetch' | 'free'
  onOutOfScope: 'deny' | 'ask'
}

type ReviewConfig = {
  main: AgentSpec
  assist?: AgentSpec      // subordinate mode: attached to main as an MCP tool
}
```

### No state machine

Comments carry no `draft → discussing → accepted` transitions. GitHub's pending review already plays that role, and a shadow state locally only creates sync problems.

`origin` is metadata, not state. There are no transitions.

### Profile storage

Three layers: global default → per-repo → per-review override.

Store the chosen `ReviewConfig` inside the `ReviewSession`. You need to be able to answer "what produced this comment?" later, and resuming a review should reuse the same configuration.

Presets are not a fixed menu — they are **named knob combinations the user saved.**

### Persistence

`~/.local/state/legible/sessions/<sessionId>.json`

Pure in-memory state loses work on daemon restart or browser refresh. This file is also the recovery path when an agent session gets compacted or reset: `list_comments()` reads back current state. It is the single source of truth.

Store a versioned record containing the review session and bounded chat transcript. Write through a
same-directory temporary file and atomic rename, with `0700` on the sessions directory and `0600`
on records. Comment mutations flush before API success; streamed chat deltas may be coalesced for up
to 200 ms and must flush when a turn settles or the daemon shuts down.

---

## 4. Diff and Anchoring

### The diff source is local git

```
git diff <base>...<head>
```

**Three dots.** That is merge-base relative and matches what GitHub's PR view shows. Two dots pulls in base-branch changes as well and produces a different screen. Getting this wrong is painful to debug later.

Why not the GitHub API as diff source: large PRs hit pagination and patch truncation, and whole-file access is more natural locally.

The GitHub API is used only for **metadata (PR info, existing review threads) and submission.**

### Parser requirements

From each unified-diff hunk header `@@ -a,b +c,d @@`, **track both line counters simultaneously**:

- Context lines: both sides advance
- Addition (`+`): right side only
- Deletion (`-`): left side only

Attach `{ leftLine: number | null, rightLine: number | null }` to every rendered line. Then no conversion is needed when placing a comment. **Retrofitting this means rewriting the parser.**

The daemon consumes `git diff` as a line stream and rejects hunks whose declared line counts do not match the parsed lines. Returning no diff is safer than returning incorrect comment anchors.

### Anchor with line + side

Do not use the legacy `position` field (diff-hunk relative offset). With `line` + `side` (plus `start_line`/`start_side` for multi-line), comments can be built from the local diff alone.

- `side: 'RIGHT'` → new-file line number
- `side: 'LEFT'` → old-file line number

Never make the agent compute `position`. It reports a path and a real line number; the daemon does the conversion.

### head SHA

No automatic detection. **Display it** in the UI — the user needs some way to notice.

Provide explicit update-check and refresh commands. Refresh keeps the session ID, configuration,
drafts, and conversation while preparing a separate UUID-suffixed worktree generation. Verify both
GitHub head and target-branch tip against fetched refs; pin their merge-base for the **whole latest
PR diff**, not just newly added commits. A target-tip change without an effective head/merge-base
change is a no-op for draft revisions. Legacy sessions with no saved target tip report unknown base
change until refresh verifies it.

Serialize refresh with comment/submission mutations; refuse active agents, unresolved submissions,
and submitted sessions whose worktree cleanup is incomplete. Close the idle agent and its MCP lease,
restore projected configuration, prepare comment mapping and a revision-boundary chat notice, then
atomically save the next session and chat as one v3 record before publishing. Read v1/v2 records as
legacy revision 0. Failed preparation/save preserves the previous revision and removes only the
candidate generation. Remove the previous worktree after commit; cleanup failure is a warning and
leaves the old generation for safe retention cleanup. Never reset or force-remove a dirty worktree.

Increment `reviewRevision` for each effective refresh or submitted-session continuation. Browser
requests carry `x-legible-review-revision` (absent means 0); MCP tools capture it in their lease.
Recheck queued mutations against the current revision. Reject stale requests and requests during
preparation with 409. Keep chat stream revisions monotonic. The browser reloads on revision events,
invalidates file caches and anchors, ignores obsolete responses, and preserves unsent text. Empty
diffs still expose conversation, refresh, submission, and history controls.

Map LEFT anchors through old/new base trees and RIGHT anchors through old/new head trees. Preserve
exact unchanged blobs and unique exact-content renames; for changed files, accept only untouched
ranges with unique matching context and validate against the new full diff. Keep uncertain anchors
as `needs_review` with their original location/revision, outside the inline diff. Submission blocks
until a human reanchors or removes them. Reanchoring retains the comment ID and conversation.

Refreshing never starts an agent. Explicit **Review again** or the next user message starts a new
read-only agent on the latest whole diff, with prior transcript and revision boundaries. Old retry
requests are discarded. After successful submission and cleanup, **Continue reviewing** archives
the receipt, pinned commits, and comments as read-only history and clears the current draft in the
same session. Submitted comment conversations are read-only. Every submission attempt has a unique
hidden marker, while reconciliation continues to honor exact legacy persisted markers.

Since submission sends the whole array, **a single stale anchor can fail the entire request with a 422.**

---

## 5. Worktree Lifecycle

```bash
git fetch origin pull/<n>/head
git worktree add --detach <path> FETCH_HEAD
```

- **Never run `gh pr checkout` in the main repo.** It switches branches and disturbs the user's working state.
- **Detached HEAD.** Reviewing involves no commits.
- **Path outside the repo:** `$XDG_STATE_HOME/legible/worktrees/<repoId>/pr-<n>`, falling back to `~/.local/state/legible/worktrees/<repoId>/pr-<n>`. Inside the repo it pollutes `git status` and ignore rules.
- **Reuse preserves the pinned head.** Preparing an existing registered worktree does not fetch or reset it. Updating to a newer PR head remains an explicit action.
- **GC is required.** `git worktree prune` only clears stale entries. Clean up on submit, plus a 14-day TTL sweep on daemon start. Active, dirty, symlinked, and unregistered paths are never removed; cleanup does not use `--force`.
- **One worktree is shared.** In subordinate mode both agents read the same tree. Both are read-only and each writes session state to its own `~/.claude` / `$CODEX_HOME`, so this is safe.

---

## 6. Agent Adapters

### Interface

```ts
type AgentEvent =
  | { type: 'session_started'; id: string; model: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'turn_completed'; usage?: Usage; costUsd?: number }
  | { type: 'error'; retryable: boolean; category: string; message?: string }

interface AgentSession {
  send(msg: string): AsyncIterable<AgentEvent>
  interrupt(): Promise<void>
  close(): Promise<void>
}

interface AgentBackend {
  start(opts: {
    cwd: string
    systemPrompt: string
    mcpServers: McpServerSpec[]
    spec: AgentSpec
  }): Promise<AgentSession>
}
```

**Do not let vendor schemas leak into the core.** The TypeScript interface above describes the
existing observable contract, not a requirement to use TypeScript in the daemon. Rust adapters
must normalize the two CLI event shapes to the same domain events.

### Match the shape on both sides

| | Existing Node adapter | Target Rust adapter |
|---|---|---|
| Claude Code | Agent SDK over local `claude` | Direct CLI headless JSON stream, with persistent input/session control verified before replacement |
| Codex | `codex app-server` over stdio | Direct `codex app-server` JSON-RPC over stdio |

Both adapters must retain the existing stateful `send` / `interrupt` / `close` behavior. A
sequence of unrelated one-shot calls is not an acceptable substitute for a live session. Pin
and test the CLI versions used by the adapters; fail visibly if a version cannot provide the
required stream, cancellation, MCP, or safety behavior. Do not read CLI-owned credentials or
replace either CLI's agent loop with raw model API calls.

`app-server` is bidirectional, so approval requests arrive inbound. Pinning read-only and auto-handling approvals erases that difference at the event-model level.

### Assist agent: subordinate mode

**Deferred: excluded from the current implementation.** If implemented later, expose the existing
stateful Codex adapter through a daemon-owned MCP tool for the main agent. The old Codex
`mcp-server` command has been removed; `codex mcp` manages external connections and does not host
Codex as a tool. Do not base new work on the previous direct-MCP design.

The user configures nothing. The daemon injects everything at spawn time.

**Known costs:**
- You do not control whether it gets called. Add something like "consult the assist agent when a judgment call is difficult" via `--append-system-prompt`.
- Attribution collapses. Codex output enters Claude's context, so `origin: 'codex'` cannot be assigned.
- Tokens are paid twice. Codex responses accumulate wholesale in Claude's context.

Parallel mode (both propose independently, human merges) can be added later since both adapters already exist. If you go parallel, **the two agents must not see each other's comments during the proposal phase** — convergence destroys the only value diversity provides.

### Never modify the user's config files

Inject knobs as spawn-time arguments. Codex takes `--config key=value`; Claude takes JSON directly via `--settings`.

### Authentication

Delegate authentication to the locally installed official CLIs. Preflight runs `claude auth status`
and `codex login status`; users sign in with `claude auth login` and `codex login`. Subscription or
API billing is a CLI concern that remains opaque to Legible. Never read, copy, store, refresh, or
return agent credentials. Agent subprocesses inherit the user's authentication environment and
configuration, while review behavior is constrained with spawn-time arguments.

The Claude adapter must invoke the local `claude` executable through its supported headless/stateful
interface, just as the Codex adapter invokes local `codex app-server`. Do not point either tool at an
empty synthetic home for isolation: that also removes CLI-owned authentication. Never read OAuth
credentials from `~/.claude` or `$CODEX_HOME` and call vendor APIs directly.

### Knob → backend mapping

A single knob hides several rules. **Keep an explicit mapping table in the adapter.**

| Knob | Claude Code | Codex |
|---|---|---|
| `shell: none` | `tools: Read,Glob,Grep` plus explicit MCP allowlist | stable read-only sandbox + shell tool off |
| `shell: git` | deferred; rejected before startup | same as `broad` in the first adapter |
| `shell: broad` | deferred; rejected before startup | shell tool on inside the read-only sandbox |
| `network: off` | WebFetch/WebSearch not allowed | command network off + web search disabled |
| `network: fetch` | `+ WebFetch,WebSearch` | command network off + live web search |
| `network: free` | deferred; rejected before startup | command network on + live web search |
| `onOutOfScope: deny` | `dontAsk` and deny permission callbacks | auto-reject approvals |
| `onOutOfScope: ask` | deferred; rejected before startup | deferred until approval UI exists |

File writes are **pinned off.** Do not expose them as a knob.

Codex's command rules control commands that request to run outside the sandbox; they are not an
in-sandbox executable allowlist. The first adapter therefore maps `shell: git` to the same behavior
as `broad` instead of presenting a false security boundary. Stable read-only mode blocks writes but
does not restrict reads to the review worktree. A scoped permission profile can replace it later
when that beta API is mature enough to require.

Start Codex projects as untrusted, disable apps and subagents, and disable every user or
plugin-provided MCP server through per-thread configuration. Preserve the real `CODEX_HOME` for
authentication, but never write its configuration. Use ephemeral app-server threads so review
sessions do not enter the user's Codex history.

Claude's `allowedTools` alone is not an allowlist: it pre-approves tools. Restrict built-ins with
`tools`, explicitly disable write/shell/delegation tools, inject only Legible MCP with strict MCP
configuration, and verify connected server tool sets. Disable hooks, executable skills, slash
commands, plugins, and automatic memory writes while retaining CLI-owned authentication and
repository guidance. Reject incompatible managed executable customizations before spawning.
Skills may be read as text. These controls are a tool boundary, not a filesystem read sandbox;
`network: off` disables research tools, not the CLI's model/authentication traffic.

The current step 8C uses a persistent SDK streaming-input query and the local `claude` executable.
The Rust replacement must reproduce its observable session behavior through the CLI's headless
stream before the SDK is removed. Acquire the base-config projection before startup and release
only after process exit. Keep restoration conflicts visible and block reuse or cleanup.
Authentication and projection notices apply to main and per-item chats. Step 8D subordinate mode
remains deferred.

### Do not validate model or effort

A hardcoded enum goes stale within weeks. Both vendors add models constantly and neither offers a reliable "list available models" command. Use free-form input and let the CLI validate; surface its error verbatim.

Do not normalize `effort` either. The value sets differ (Codex ranges from `none` to `xhigh`). A shared enum will fail to express some values.

---

## 7. Respect Repo Conventions

If a repo has review guidelines or conventions, they take precedence over Legible's defaults. **Preserve what the team built.**

### What to collect

| File | Use |
|---|---|
| `CONTRIBUTING.md` | Review standards, coding conventions |
| `.github/PULL_REQUEST_TEMPLATE.md` | What this team cares about in a PR |
| `.github/CODEOWNERS` | Who owns which files |
| `CLAUDE.md`, `AGENTS.md` | Agent-facing project instructions |
| `.claude/skills/*/SKILL.md` | Registered skills |
| `REVIEW.md`, `docs/code-review.md` | Highest priority when present |
| Linter/formatter config | **What *not* to comment on** |

That last row is underrated. Flagging things the formatter already handles is the single largest source of review noise. When `.eslintrc`, `rustfmt.toml`, `.editorconfig` and friends exist, state explicitly that those concerns are automated and should not be raised.

### Precedence

```
repo conventions  >  user global settings  >  Legible default prompt
```

The repo wins on conflict. Safety constraints — **read-only, submission is the human's** — cannot be overridden by repo documents.

### Loading

**Rely on auto-discovery.** Do not cherry-pick from skills and instructions. Loading what the team wrote beats having the tool reinterpret it, and it means less code.

The only addition is a framing line, via `--append-system-prompt`:

> You are reviewing this PR. What follows are this repository's development guidelines.

`CLAUDE.md`-style files are usually written for an agent that *writes* code, so items like "run tests before committing" appear. Rather than editing the content, just make the role explicit.

Claude and Codex auto-discover different files (`CLAUDE.md` vs `AGENTS.md`). When only one is present, the adapter injects it into the other backend as well.

### Text guidance: use the PR's version

`CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `CONTRIBUTING.md` and similar are used **as they appear in the PR, even when the PR modified them.**

When reviewing a PR that adds or edits skills and conventions, it is natural for that change to be in effect during the review. Worst case is degraded review quality.

### Executable config: use the base version

Hooks in `.claude/settings.json` and `.mcp.json` are not guidance — they are **code.** They execute before the agent ever reads them. They are part of the review tool's runtime, not the review subject.

A `-p` session shows no workspace-trust dialog, so a project's hooks run and its `.mcp.json` servers connect even in a folder that was never trusted. With a worktree checked out to a PR branch, that is a direct attack surface. Even a trusted author leaves fork-sourced PRs, compromised accounts, and poisoned dependencies.

Rules:

- After creating the worktree, diff `.claude/settings.json` and `.mcp.json` between base and head
- Also treat `.claude/settings.local.json` as executable configuration if a repository tracks it
- If changed, **project the base version** into the worktree before spawning the agent
- Surface it prominently in the UI. PRs that change hooks or MCP config are rare, and exactly the kind a human should look at
- The change still renders normally in the diff view, which reads from git objects and is unaffected by worktree manipulation

Projection is temporary and reference-counted so multiple agents can share one worktree. Record the
expected base and head blob identities in an owner-only manifest before changing a file, restore the
head version when the last agent exits, and recover stale manifests before startup worktree GC. If a
protected file matches neither recorded version, preserve it as a user edit, keep the manifest, and
block another projection instead of overwriting it.

`--safe-mode` skips this auto-discovery while preserving CLI-owned authentication, but it also
discards skills and guidance, defeating the purpose of this section. Restoring the base version is
the more precise fix.

Ship this in v0. Retrofitting means reopening the worktree creation path.

---

## 8. MCP Tools

The daemon **spawns a separate MCP endpoint per session with the agent's identity embedded.** Never ask the agent to report its own name — it gets it wrong and there is no basis to trust it. The daemon determines `origin` from the session token.

### Comment manipulation (local array)

```
add_comment(path, line, side, body, start_line?, start_side?)
edit_comment(id, body)
remove_comment(id)
list_comments()
```

All local array operations, so no GitHub permissions are involved.

### UI integration

```
focus(path, line_range)   # scroll the diff view to this location
```

When the agent explains a piece of code, the view follows. This is the single biggest contributor to the sense of immersion.

### GitHub reads

```
get_issue(number)
get_pr(number)
search_code(query)
list_pr_comments()
```

The daemon services these through Octokit. **Do not give the agent `gh`.** Reasons:

- Write vectors disappear from the schema (`gh pr comment`, `gh pr review`, `gh issue close` are the same binary)
- No need to express the same restriction twice in Claude's `--allowedTools` syntax and Codex's execpolicy
- No GitHub token leaves the daemon

Mounting the official GitHub MCP server wholesale is also discouraged: dozens of tools arrive, writes among them, and you end up maintaining a per-tool allowlist anyway.

### Submission is not exposed as a tool

The human submits via a UI button. Handing that to the agent turns collaboration into supervision.

---

## 9. GitHub Access

| Purpose | Mechanism |
|---|---|
| Obtain auth token | `gh auth token` |
| Check auth status | `gh auth status` |
| PR metadata, file list | Octokit REST |
| Review thread resolve state | Octokit GraphQL (not available via REST) |
| Submit review | `POST /repos/{o}/{r}/pulls/{n}/reviews` |

`gh` remains only as an **auth broker.** Far better than registering an OAuth app.

### Submission

```
POST /repos/{owner}/{repo}/pulls/{number}/reviews
{
  "commit_id": "<headSha>",
  "event": "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
  "comments": [ { path, line, side, start_line?, start_side?, body }, ... ]
}
```

Pending reviews are not used. Only one can exist per PR, which collides with anything started in the GitHub web UI, and there is no reason to round-trip drafts while they are still being edited. Freeze locally, send once.

Because it is a local array, edits like "soften #3" or "merge #1 and #4" happen instantly with no API round trip. That is the core of the back-and-forth.

---

## 10. Review UI and Client Hosts

### Screens

```
/                        recent reviews + open repository
/repos/:owner/:name      PR list
/review/:sessionId       review screen
```

The current browser SPA uses these routes. Its WebSocket survives screen transitions so concurrent
review status stays visible. The desktop window should reuse these review components; host-specific
navigation, daemon connection, and authentication must not be embedded in the diff or chat views.

### Client boundary for desktop and future VS Code

Expose a small UI-side connection interface for authenticated requests, event subscriptions,
reconnect/snapshot recovery, and navigation. The current browser implementation uses same-origin
HTTP/WebSocket and URL-fragment bootstrap authentication. A desktop host can initially use the
same daemon API, but WebView-specific APIs must remain in its host adapter. Do not make the
React review components depend on a particular desktop framework.

A future VS Code extension is a thin client of the same daemon, not another daemon or agent
implementation. In remote workspaces, its
[workspace extension host](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
runs beside the checkout and daemon, while its Webview runs on the user's machine. The Webview
should use [message passing](https://code.visualstudio.com/api/extension-guides/webview) through
the extension host rather than assume that `localhost` names the daemon host. The extension host
owns daemon connection details; bootstrap tokens and agent/GitHub credentials must
not be sent to Webview code. Reuse React review components where practical, while allowing a
separate entry point, asset URLs, content-security policy, and navigation for VS Code. Native
editor decorations or a full browser-based VS Code extension are not required for the first
extension release. The extension host may use VS Code's Node runtime without making Node a
runtime dependency of the Rust daemon.

### First run

A path input and **Open repository** button register an existing GitHub.com checkout. A folder
picker is deferred. First-run and populated home screens share setup status, but only the latter
shows saved repository links and recent reviews.

The path root is `LEGIBLE_BROWSE_ROOT`, defaulting to `$HOME`. It is not editable in the UI.
Normalize with realpath, verify containment, find the Git top level, and verify containment again.
Accept regular clones only. Reject linked worktrees, bare repositories, non-GitHub.com origins,
and remote URLs with embedded credentials. The registry persists canonical paths and keeps its first
primary checkout unless explicitly changed; revalidate origin and checkout identity before worktree operations.

The PR page lists 30 open PRs per page and accepts a PR number directly. Agent selection defaults
to Claude with shell/network off; switching to Codex defaults to broad commands within its read-only
sandbox. Model and effort remain free-form. Preparing a session never starts an agent.

Serialize session creation by repository/PR, and Git operations by common Git directory. Fetch into
dedicated refs without changing FETCH_HEAD, verify the advertised head/base, and pin merge-base.
Persist before publishing the new session. Reopening preserves the existing pinned review and updates
its last-opened timestamp; submitted sessions open their receipt. Explicit refresh and continuation
are described above. Multi-repository cleanup resolves and validates the session's exact registered
worktree, including its generation suffix.

From the second run onward, **recent items are the first screen.** Design the empty state and the everyday state separately.

### Repository and saved-review management

The home screen filters recent reviews by repository and visibility/submission state, newest-opened
first. Archive is a reversible metadata transition (`archivedAt`, optional in v3 records), not deletion.
Preserve comments, chats, pinned revisions, receipts/history and worktrees. Include archived sessions
in snapshots and active worktree protection; hide them by default in the UI. Archive rejects active
agents, refreshes, pending mutations, uncertain/in-flight submissions and incomplete cleanup. Serialize
the transition with session mutations and block new turns during persistence. Save before publish;
failed saves leave the old state visible. Archived review operations are locked until explicit restore
or reopen. Direct archived URLs offer restore before loading the diff. Reopening reuses the same
session without fetching commits or invoking a model. Restore does not change the review revision.

Checkout management shows all registered canonical paths, current availability and primary-change
restrictions. Forgetting only removes a non-primary registry entry; it does not touch the filesystem.
The primary is mandatory. Changing it requires a valid registered target with matching origin, zero
saved sessions (including archived/submitted history), and no linked worktrees on the current primary.
Fail closed if the current checkout cannot be inspected. This conservative rule avoids redirecting
old worktree ownership to an unrelated clone. Serialize registry changes and worktree operations,
holding the registry lock from new review preparation through persistence/publication. Reuse that lock
for nested worktree operations. Revalidate all dependencies inside the lock, never trust UI status.

Authenticated management API: `GET /api/repos/:owner/:name/checkouts`, `PATCH .../primary` and
`DELETE .../checkouts` with an exact registered path, plus revision-guarded
`POST /api/sessions/:sessionId/archive` with an `archived` boolean. Confirmed permanent deletion
requires an archived, idle review with no unresolved submission. Save a deletion intent before
removing its clean, exactly owned worktree; then durably remove its session/chat record before
publishing removal. A failed cleanup leaves the intent visible and locked for retry, and startup
resumes pending intents before worktree sweeping. Repository unregistration requires zero saved
sessions and no linked worktrees, and removes only registry metadata. Neither action deletes the
primary checkout or any GitHub review. Moving linked worktrees between clones remains deferred.

Also on the first screen:
- Preflight results (`gh` / `claude` / `codex` auth status)
- A direct path input — users arriving over SSH prefer pasting to clicking

### Directory picker

Do not build a general-purpose file browser. That turns the daemon into a remote file explorer, and one leaked token exposes the entire home directory instead of a review tool.

- List directories only; never files
- Treat a directory containing `.git` as a **leaf** and badge it. Do not descend
- Exclude hidden directories, `node_modules`, `target` by default
- **Validate paths**: normalize, then confirm the result is under the root. `../` injection is the classic failure for this kind of API

Selecting a leaf registers the repo and auto-fills owner/name from `origin`.

Implemented as `GET /api/directories` with optional absolute `path`. The daemon resolves the
configured browse root and requested path, checks canonical containment and rejects direct paths
through excluded names or below any ancestor with a `.git` marker. A repository is a leaf even when
requested directly. Directory entries are not followed through symlinks, files are never listed,
and changed or inaccessible paths fail closed. Cap output at 200 directories and inspection at
2,000 entries per request; mark incomplete results. Limit concurrent directory reads to four. The
browser offers a breadcrumb-like Up action and retry, while preserving the direct path field.
Selecting a leaf calls the existing registration API, which revalidates path, Git identity, and
GitHub origin before navigating to the derived owner/name.

### Review screen

- Diff view (unified first; side-by-side if time allows) + whole-file toggle
- Main chat + per-item chats
- Comment list with origin badges
- head SHA display

**Per-item chats are filtered views of a single PR session, not separate sessions.** Messages carry an `itemId` and each view shows only its own. The daemon prepends context on send:

```
[comment #3: src/auth.rs:42] soften the tone
```

Splitting sessions makes "merge #1 and #4" impossible and starts every chat without any understanding of the PR.

Do not display multiple item chats at once. Selecting a comment opens its chat in place and scrolls the diff to it.

### Whole-file view

Wanting to see a full file mid-review is the normal flow, not an exception. But only **reading** is needed, which is why this does not justify moving into VSCode.

The files are already in the worktree, so the added cost is near zero.

Stages:
- v0 — whole-file toggle, expand collapsed regions between hunks
- v1 — in-file search plus worktree-wide grep (grep is needed more often than go-to-definition)
- v2 — LSP-backed definition and reference lookup (cost jumps sharply; asking the agent covers much of this)

Implemented v1 searches the **pinned HEAD tree**, not mutable working-copy contents: projected agent
configuration and local edits must not become review search content. The UI has a case-sensitive
literal finder for the displayed diff/whole file (Ctrl/Cmd+F, Enter/F3 and reverse navigation, Escape)
and an explicit repository search sidebar. Results open read-only whole files at real line numbers.
Only ranges already present in the PR diff retain comment anchors, even in a search preview.

`GET /api/sessions/:sessionId/search?q=...` returns `CodeSearchResult` with `headSha`, `reviewRevision`,
matching paths/lines/previews, `truncated`, and `skippedLargeFiles`. `GET .../search/file?path=...`
opens regular tracked blobs at the same HEAD. These routes share browser authentication and revision
guards, reject submitted sessions, and recheck the revision after reading. Neither accepts a SHA,
checkout path, or arbitrary root. `/file` remains restricted to diff paths. Git tree mode validation
excludes symlinks and submodules; blob reads use verified object IDs, never filesystem traversal.

Search uses literal, case-sensitive `git grep` against eligible HEAD paths, with NUL-delimited names
and line numbers, no shell, pager, recursive submodules, lazy fetching, or textconv. Bounds: query
256 UTF-8 bytes, file 1 MiB, tree enumeration 8 MiB, grep output 2 MiB, 200 matching lines, 400-character
previews, and 5 seconds per operation. Overlarge files are counted; incomplete grep results are
marked partial, while incomplete tree enumeration fails closed. Invalid UTF-8 previews are not
rendered. Limit concurrent search/file reads to one per session and four daemon-wide. Abort Git on
disconnect/cancellation. PR refresh discards results and previews; ignore obsolete browser replies.
The view-local finder caps highlights at 1,000 matches. LSP, regex search, and remote GitHub search
remain outside this increment; no model invocation or MCP expansion is involved.

---

## 11. Security

- **9A binds only to loopback.** Direct external binding is rejected; remote users use SSH forwarding.
- The daemon holds both GitHub and agent credentials. The moment it listens on a network, anyone on it can post comments as the user and burn the user's agent quota.
- A per-start bootstrap token is printed in the URL fragment, removed immediately by the SPA, and
  exchanged for a separate HttpOnly/SameSite=Strict cookie. All user APIs and WebSocket upgrades
  require authentication and local Host/Origin checks. Missing mutation/WS origins are rejected.
  Agent MCP retains separate session-bound bearer auth. Never log tokens, cookies, or auth bodies.
- Design the daemon API to be **network-transparent** (WebSocket + token). A Unix-socket-only design has to be torn out when one UI needs to attach to daemons on several machines.
- The browser's URL-fragment-to-cookie exchange is a browser entry flow, not the only client
  authentication mechanism. Desktop and editor hosts may obtain daemon access through a private
  local control channel, but must not expose the bootstrap secret to embedded WebView code.
  Version the client/daemon contract so an older desktop app or extension fails clearly against
  an incompatible daemon instead of misinterpreting review state.

### Over SSH

The daemon is remote; the browser is local. The CLI suppresses automatic browser launch over SSH;
forward manually and open the printed URL locally:

```
ssh -L 7777:localhost:7777 <host>
```

**Pin the port.** Users should be able to add `LocalForward 7777 localhost:7777` to their ssh config once and forget it. Avoid random ports.

An overlay network like Tailscale removes the problem entirely, but the tool must not depend on one. Offer `--bind` and leave the rest to the user's environment.

---

## 12. Legal Boundaries

- Run the CLI/SDK through supported paths. **Never read OAuth credentials from `~/.claude` and call `api.anthropic.com` directly.** That is the pattern that actually caused trouble.
- On distribution, each user runs with their own credentials. Do not relay the developer's account.
- Distribution and commercial use of the current Node build must follow the SDK license and
  Commercial Terms. The target CLI-based build needs its own terms review; do not assume a paid
  subscription guarantees included usage.
- Branding: the product must not look like Claude Code or any Anthropic product. Maintain its own identity.
- This area changes often. Re-check the Usage Policy and Commercial Terms at the point of any distribution decision.

**The larger practical risk is company policy, not terms of service.** Reviewing company code through a personal account is the real exposure, so keep auth profiles separate from the start.

As checked on 2026-09-13, Anthropic's [Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance)
describes embedding an unmodified CLI with end-user-owned authentication and direct billing, subject
to its terms. Legible invokes the user's installed executable; it does not relay credentials or
resell access. The [SDK license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md)
is governed by Commercial Terms. Recheck both before distributing.

The [SDK subscription notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
currently says the announced SDK/headless billing separation is paused. This is not a pricing
promise: inherited API keys can select API billing, provider credentials follow provider billing,
and enabled usage credits can incur additional charges. Show only the CLI-reported authentication
category, without email, organization identifiers, or tokens; never change the user's auth method.
The SDK-specific statements describe the current Node build. Recheck the applicable CLI terms and
billing guidance before distributing the Rust build; changing the client language does not settle
the user's billing or redistribution rights.

---

## 13. Implementation Order

The original Node/browser implementation order is retained below as a record of the existing
baseline. Do not restart these milestones merely because the runtime changes.

| # | Step | Notes |
|---|---|---|
| 1 | Daemon skeleton | WebSocket event bus, session registry, preflight. Hardcode the repo path |
| 2 | Worktree lifecycle | Create/reuse/GC. Messy, so hit it early |
| 3 | **Diff parsing + viewer** | Largest single chunk of v0. CodeMirror decorations + inline widgets. Half the time goes here |
| 4 | Codex adapter core | Stateful app-server transport, permission knobs, event normalization |
| 5 | Codex main chat | HTTP/WebSocket lifecycle and streamed UI |
| 6A | Comment array + persistence | Inline single/multi-line drafts and restart recovery |
| 6B | Submit | GitHub review write and post-submit worktree cleanup |
| 7 | MCP tools + per-item chats | `itemId` routing |
| 8A | Local CLI authentication boundary | Delegate credentials and billing mode to the official CLIs |
| 8B | Base executable-config projection | Restore safely after agent exit and daemon crashes |
| 8C | Claude adapter + prompt/tool hardening | Stateful local CLI transport with deterministic read-only controls |
| 8D | Subordinate mode (deferred) | Explicitly excluded from the current implementation |
| 9A | Web entry flow | Path registration, multi-repo PR preparation, agent selection, recent reviews, local browser auth |
| 9B | CLI lifecycle | Background attach/start, singleton ownership, browser handoff, status/idle stop; Unix/WSL |
| 9C | Same-session refresh/re-review | Whole latest PR diff, conservative anchors, revision guards, submitted history |
| 9D | Code search | View-local literal finder, bounded pinned-HEAD grep, read-only result navigation |
| 9E | Repository/session management | Review filtering, reversible archive/restore, validated checkout management with dependency guards |
| 9F | Directory picker | Bounded directory-only listing below the browse root and Git-leaf registration |
| Later | Entry and review follow-ups | Permanent deletion, native Windows, packaging, remote binding separately |

**Step 3 will take twice as long as expected.** A diff viewer with inline widgets is universally underestimated until you build one. If it stalls, dropping side-by-side and shipping unified only is the escape hatch.

Keep the adapter core separate from its HTTP/WebSocket and UI integration. Prove the stateful Codex
contract first, wire the main chat second, and add the second backend only after the first backend's
session lifecycle has settled.

### Rust/desktop migration

1. Freeze the existing API, event, persistence, and safety behavior with contract fixtures and
   process tests, then introduce the root Cargo workspace with protocol and daemon crates alongside
   the existing npm workspace. Decide and document a versioned state migration before replacing a
   user's installed daemon; never silently discard saved reviews or worktrees.
2. Establish the standalone Rust daemon and CLI lifecycle while preserving local-only binding,
   authenticated browser access, singleton ownership, and the current review API. Keep the Node
   daemon available as the comparison implementation until parity is demonstrated.
3. Port domain services and the Codex app-server adapter, then port the Claude CLI adapter after
   proving persistent streaming, interruption, tool restrictions, MCP initialization checks,
   and base-config projection with real-process tests. Remove the SDK only after that parity gate.
4. Separate the React connection/navigation layer from review components, then add the desktop
   WebView shell. Verify local use and an SSH-connected daemon before changing distribution.
5. Package and smoke-test the chosen desktop platforms. Build a VS Code extension only as a later
   client of the same versioned daemon contract; test both local and Remote-SSH extension hosts.

The desktop framework, first release platforms, updater, and whether external tools are bundled
remain distribution decisions. They must not determine the daemon domain model or make a future
VS Code client dependent on the desktop shell.

---

## Appendix: Packaging

`legible` is taken on npm (a 2016 HTTP library, unmaintained since 2022), but **the CLI command name is independent of the package name.**

```json
{
  "name": "@<scope>/legible",
  "bin": { "legible": "./dist/cli.js" }
}
```

Users type `legible`.

The current local distribution smoke build stages one private npm package under `dist/package`:
compiled Node daemon and web assets, plus a bundled copy of the browser-safe protocol package.
It does not publish to npm or select a public release scope. An isolated tarball-install test
checks the current CLI, daemon startup, and static assets.

The target distribution contains a Rust daemon executable, the desktop shell, and built UI
assets. The same daemon executable must also be runnable without a desktop window on an SSH host.
Keep per-platform binaries, signing, updates, and optional tool bundling separate from the
browser/API contract; the current npm tarball is not the desktop release format.

### Casing

Lowercase `legible` for identifiers — CLI command, npm package, repo name, paths. Capitalized `Legible` for prose — README headings, documentation, "Legible runs as a local daemon." Same convention as ripgrep/`rg` and Vite/`vite`.
