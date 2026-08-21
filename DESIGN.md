# Legible — Design Document

AI-assisted GitHub PR review tool. Local daemon + web UI.

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

```
[Browser SPA] ──HTTP/WS──> [Legible daemon (TypeScript)]
                                  │
                                  ├─ git worktree management
                                  ├─ Octokit (GitHub API)
                                  ├─ Agent adapters ─── Claude Agent SDK
                                  │                  └─ Codex app-server
                                  └─ MCP server (per-session instance)
```

### Principles

- **One daemon per machine.** It holds multiple repos and multiple PRs.
- **Review sessions are decoupled from browser tab lifetime.** Close the tab, the session survives; reopen and it resumes.
- **The daemon is the sole credential holder.** No GitHub token ever reaches an agent process.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Daemon | TypeScript (Node) | Official Claude Agent SDK, `codex app-server generate-ts` for typed clients, shared types with the frontend |
| Frontend | Vite + React SPA | Next.js presupposes its own server → duplicates the daemon. No SSR/SEO need |
| Editor | CodeMirror 6 | Read-only plus inline widgets maps exactly onto the decoration model. Lighter than Monaco |
| GitHub | Octokit (REST + GraphQL) | Shelling out to `gh` means fragile output parsing |

Next.js was ruled out not because Node is unavailable — Claude Code requires Node, so it is always present — but because **it would create a second request-handling layer** alongside the daemon.

### Startup

```
legible              # start daemon if absent, register cwd repo, print URL
legible pr 123       # deep-link straight into a review
legible add <path>   # register a repo only
```

Lock at `~/.local/state/legible/daemon.sock`. If alive, attach; otherwise spawn. **Must be idempotent.**

Preflight on startup: presence and version of `git`, `gh`, `claude`, `codex`, plus auth status (`gh auth status` etc.). Failing here beats dying mid-review on an expired token.

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
  origin: 'claude' | 'codex' | 'human'
  createdAt: string
}

type AgentSpec = {
  backend: 'claude' | 'codex'
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

### Anchor with line + side

Do not use the legacy `position` field (diff-hunk relative offset). With `line` + `side` (plus `start_line`/`start_side` for multi-line), comments can be built from the local diff alone.

- `side: 'RIGHT'` → new-file line number
- `side: 'LEFT'` → old-file line number

Never make the agent compute `position`. It reports a path and a real line number; the daemon does the conversion.

### head SHA

No automatic detection. **Display it** in the UI — the user needs some way to notice.

Provide a command for when they do notice: refresh the worktree to the latest head and tell the agent that the PR was updated and new commits should be reviewed.

Since submission sends the whole array, **a single stale anchor can fail the entire request with a 422.**

---

## 5. Worktree Lifecycle

```bash
git fetch origin pull/<n>/head
git worktree add --detach <path> FETCH_HEAD
```

- **Never run `gh pr checkout` in the main repo.** It switches branches and disturbs the user's working state.
- **Detached HEAD.** Reviewing involves no commits.
- **Path outside the repo:** `~/.local/state/legible/worktrees/<repoId>/pr-<n>`. Inside the repo it pollutes `git status` and ignore rules.
- **GC is required.** `git worktree prune` only clears stale entries. Clean up on submit, plus a TTL sweep on daemon start.
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
  | { type: 'error'; retryable: boolean; category: string }

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

**Do not let vendor schemas leak into the core.** The two CLIs emit fundamentally different event shapes; adapters normalize to the model above.

### Match the shape on both sides

| | One-shot | Stateful |
|---|---|---|
| Claude Code | `claude -p` | **Agent SDK** ← use this |
| Codex | `codex exec --json` | **`codex app-server`** ← use this |

Both go stateful. Mixing `claude -p` with `app-server` forces the interface to cover one-shot and stateful at once, and it collapses to the lowest common denominator.

`app-server` is bidirectional, so approval requests arrive inbound. Pinning read-only and auto-handling approvals erases that difference at the event-model level.

### Assist agent: subordinate mode

Run Codex via `codex mcp` (Codex itself as a stdio MCP server) and **attach it as a tool of the main agent.** For Claude Code, inject it inline through `--mcp-config`.

The user configures nothing. The daemon injects everything at spawn time.

**Known costs:**
- You do not control whether it gets called. Add something like "consult the assist agent when a judgment call is difficult" via `--append-system-prompt`.
- Attribution collapses. Codex output enters Claude's context, so `origin: 'codex'` cannot be assigned.
- Tokens are paid twice. Codex responses accumulate wholesale in Claude's context.

Parallel mode (both propose independently, human merges) can be added later since both adapters already exist. If you go parallel, **the two agents must not see each other's comments during the proposal phase** — convergence destroys the only value diversity provides.

### Never modify the user's config files

Inject knobs as spawn-time arguments. Codex takes `--config key=value`; Claude takes JSON directly via `--settings`.

**Trap:** pointing Codex at a dedicated `CODEX_HOME` for isolation also removes its authentication, which lives there. You must use the real CODEX_HOME and override with `--config`. Claude's `--bare` has the same structure — bare mode does not read OAuth credentials, so it needs `ANTHROPIC_API_KEY`. On both sides you get a clean environment or subscription auth, not both.

### Knob → backend mapping

A single knob hides several rules. **Keep an explicit mapping table in the adapter.**

| Knob | Claude Code | Codex |
|---|---|---|
| `shell: none` | `--allowedTools "Read,Glob,Grep"` | `--sandbox read-only` + minimal execpolicy |
| `shell: git` | `+ Bash(git log *)`, `Bash(git blame *)`, `Bash(git show *)`, `Bash(git diff *)` | same prefixes in execpolicy |
| `shell: broad` | additional rules | additional rules |
| `network: off` | WebFetch/WebSearch not allowed | network access off |
| `network: fetch` | `+ WebFetch,WebSearch` | network access on |
| `onOutOfScope: deny` | deny mode | auto-reject approvals |
| `onOutOfScope: ask` | surface approval in chat | route inbound approval to UI |

File writes are **pinned off.** Do not expose them as a knob.

In `--allowedTools` prefix matching, **the space in `Bash(git log *)` matters.** `Bash(git log*)` would also match `git log-something`.

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
- If changed, **restore the base version** before spawning the agent
- Surface it prominently in the UI. PRs that change hooks or MCP config are rare, and exactly the kind a human should look at
- The change still renders normally in the diff view, which reads from git objects and is unaffected by worktree manipulation

`--bare` skips all this auto-discovery, but bare mode cannot use subscription auth (same trade-off as §6) and discards skills and guidance along with it, defeating the purpose of this section. Restoring the base version is the more precise fix.

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

## 10. Web UI

### Screens

```
/                        recent reviews + open repository
/repos/:repoId           PR list
/review/:sessionId       review screen
```

SPA router. The WebSocket must survive screen transitions so concurrent review status stays visible in one UI.

### First run

A single **Open repository** button → file browser starting at the home directory.

The browse root is a config value defaulting to `$HOME`. Not exposed in the UI. Do not hardcode it — corporate NFS and `/mnt/...` mounts will come up.

From the second run onward, **recent items are the first screen.** Design the empty state and the everyday state separately.

Also on the first screen:
- Preflight results (`gh` / `claude` / `codex` auth status)
- A direct path input — users arriving over SSH prefer pasting to clicking

### The browser is a repo picker

Do not build a general-purpose file browser. That turns the daemon into a remote file explorer, and one leaked token exposes the entire home directory instead of a review tool.

- List directories only; never files
- Treat a directory containing `.git` as a **leaf** and badge it. Do not descend
- Exclude hidden directories, `node_modules`, `target` by default
- **Validate paths**: normalize, then confirm the result is under the root. `../` injection is the classic failure for this kind of API

Selecting a leaf registers the repo and auto-fills owner/name from `origin`.

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

---

## 11. Security

- **Bind to `127.0.0.1` by default.** Exposure requires an explicit `--bind` plus a token.
- The daemon holds both GitHub and agent credentials. The moment it listens on a network, anyone on it can post comments as the user and burn the user's agent quota.
- Embedding a token in the URL `legible` prints keeps local friction at zero while providing a minimum remote defense.
- Design the daemon API to be **network-transparent** (WebSocket + token). A Unix-socket-only design has to be torn out when one UI needs to attach to daemons on several machines.

### Over SSH

The daemon is remote; the browser is local. Detect `SSH_CONNECTION` and print the forwarding command verbatim:

```
ssh -L 7777:localhost:7777 <host>
```

**Pin the port.** Users should be able to add `LocalForward 7777 localhost:7777` to their ssh config once and forget it. Avoid random ports.

An overlay network like Tailscale removes the problem entirely, but the tool must not depend on one. Offer `--bind` and leave the rest to the user's environment.

---

## 12. Legal Boundaries

- Run the CLI/SDK through supported paths. **Never read OAuth credentials from `~/.claude` and call `api.anthropic.com` directly.** That is the pattern that actually caused trouble.
- On distribution, each user runs with their own credentials. Do not relay the developer's account.
- If it becomes a business, switch to API keys under the Commercial Terms.
- Branding: the product must not look like Claude Code or any Anthropic product. Maintain its own identity.
- This area changes often. Re-check the Usage Policy and Commercial Terms at the point of any distribution decision.

**The larger practical risk is company policy, not terms of service.** Reviewing company code through a personal account is the real exposure, so keep auth profiles separate from the start.

---

## 13. Implementation Order

Riskiest first. **Follow the order.**

| # | Step | Notes |
|---|---|---|
| 1 | Daemon skeleton | WebSocket event bus, session registry, preflight. Hardcode the repo path |
| 2 | Worktree lifecycle | Create/reuse/GC. Messy, so hit it early |
| 3 | **Diff parsing + viewer** | Largest single chunk of v0. CodeMirror decorations + inline widgets. Half the time goes here |
| 4 | Claude adapter + main chat | Stream parsing, permission knobs, event normalization |
| 5 | Comment array + persistence + submit | Including head SHA display |
| 6 | MCP tools + per-item chats | `itemId` routing |
| 7 | Codex adapter + subordinate mode | After the adapter interface has found its shape in steps 3–6 |
| 8 | Shell | Browser, repo registration, PR list, recent items, token auth. Easiest and lowest risk |

**Step 3 will take twice as long as expected.** A diff viewer with inline widgets is universally underestimated until you build one. If it stalls, dropping side-by-side and shipping unified only is the escape hatch.

**Do not pull the second backend or the profile knobs forward.** Leave a slot for the adapter interface, get through step 3 with Claude alone, then plug in Codex. That reaches dual review faster than doing both up front.

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

### Casing

Lowercase `legible` for identifiers — CLI command, npm package, repo name, paths. Capitalized `Legible` for prose — README headings, documentation, "Legible runs as a local daemon." Same convention as ripgrep/`rg` and Vite/`vite`.
