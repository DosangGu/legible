# Legible

Legible is an AI-assisted GitHub pull request review tool. The current implementation is a
Node daemon and browser UI; the commands below describe that working version. See
[`DESIGN.md`](./DESIGN.md) for the product and architecture specification.

The planned next architecture is a standalone Rust daemon plus an independent desktop window
that reuses the React review UI. Rust will talk directly to the locally installed `claude` CLI
and `codex app-server`, without an agent SDK dependency. The daemon remains usable without the
desktop window on an SSH host. A future VS Code extension can use the same daemon as another
client; it will not embed a second review engine. Direct browser access remains supported in the
target architecture: every client uses the same HTTP/JSON API and WebSocket event contract.
The Cargo workspace, shared Rust wire models, session storage/registry/recovery, and authenticated
read-only HTTP application are implemented as libraries. Production daemon startup, WebSocket
delivery, agent execution, and the desktop shell have not been ported yet.
The current npm package runs the Node implementation.

The root Cargo workspace contains `crates/protocol` and the `crates/daemon` library/scaffold. The desktop
shell will join it later. The React UI and future VS Code extension keep npm tooling. Cargo and
npm coexist in the repository; the Node daemon remains the runnable application during migration.

Legible has not been released. The Rust rewrite does not preserve old Node storage formats or
provide backward-compatibility layers; protocols and storage may change with the current clients
and tests before release. Local data is not automatically deleted or converted.

## Development

Use Node.js 24 and npm 11. With `nvm`, run:

```bash
nvm use
npm ci
```

The repository is an npm workspace with separate browser, daemon, and shared-code packages.

| Command          | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `npm run dev`    | Watch protocol types and the daemon while running the Vite dev server |
| `npm run build`  | Build protocol, daemon, and web workspaces in dependency order        |
| `npm test`       | Build the shared protocol, then run the Vitest suite                  |
| `npm run lint`   | Run ESLint with warnings treated as errors                            |
| `npm run format` | Format supported files with Prettier                                  |
| `npm run check`  | Run all npm and Rust CI validations                                   |

### Rust workspace

Install Rust with rustup; `rust-toolchain.toml` selects stable Rust with rustfmt and Clippy. Run:

```bash
cargo check --workspace --locked
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run -p legible-daemon -- --version
```

The Rust daemon binary currently supports only `--help` and `--version`. It does not listen on
a port or access saved sessions. Continue using the npm commands below to run a review.

Rust and TypeScript tests share `packages/protocol/fixtures/wire.json`. The fixture source in
`packages/protocol/src/testing/wire-fixtures.ts` is type-checked against the current TypeScript
protocol on every protocol build. When changing the contract fixtures, regenerate the JSON with
`npm run fixtures:write --workspace @legible/protocol`, then run both test suites. Rust tests check
current wire shapes, omitted versus nullable fields, diff sides, and submission/event variants.
Fixtures are excluded from the production TypeScript package. CI validates Rust and npm on Linux
and macOS separately.

`crates/daemon/src/sessions/store.rs` reads and writes one Rust storage format (`version: 1`),
with explicit review revisions, from an explicitly supplied state directory. Saves use a synced,
private temporary file and atomic rename. `crates/daemon/tests/fixtures/session-records.json`
covers drafts, submission history, both agent backends, and chat requests. There is no legacy
reader or version conversion. Loading does not rewrite records or resume agents. Unknown fields,
invalid metadata, and symlinked records fail closed.

`SessionService` opens and recovers all records before exposing a read-only `SessionRegistry`.
Adds/replacements/removals finish on disk before changing registry ownership or returning a
lifecycle event. Callers pass the expected review revision; draft updates reject archived/deleting
reviews. Interrupted chats become failed without starting an agent, keep retry requests and partial
tool output, and clear live-turn hints. An explicit `flush()` checkpoints recovery for the next
restart and reports every failed save. These are library operations only: production HTTP startup,
the live chat loop, event transport, and the 200 ms streaming-write scheduler are still unimplemented
in Rust.

`crates/daemon/src/api` provides a read-only Axum application. It does not open state, probe tools,
checkpoint recovery, or start agents. The caller supplies a loaded session service and preflight
report, and explicitly changes readiness from `starting` to `ready`. Starting/stopping applications
return 503 with `Retry-After`. A listener helper rejects non-loopback addresses; production singleton
ownership and graceful shutdown are still future work.

The application supports `POST /api/auth`, `GET /api/auth`, `/api/health`, `/api/preflight`,
`/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/comments`, and `/api/sessions/:id/chat`.
The auth exchange accepts a bounded JSON bootstrap token and sets a distinct per-instance
HttpOnly/SameSite=Strict cookie. Local Host/Origin checks reject rebinding and cross-origin requests;
bootstrap tokens and MCP-style bearer tokens cannot authenticate ordinary reads. Comments/chat
reads require an explicit `X-Legible-Review-Revision`; malformed/missing values return 400 and
stale revisions return 409. Archived/deleting records remain readable. Chat responses expose only
the recovered snapshot, never internal active/retry requests; missing snapshots are unavailable
without starting an agent. Static UI serving and `/api/events` are not implemented in this slice.
The executable remains informational; the HTTP tests use temporary state and include a real
loopback request.

## Open a review

For the built application, start or attach through the CLI:

```bash
npm run build
npm run legible
# Or open a PR from the current checkout:
npm run legible -- pr 123
```

The daemon workspace exposes a `legible` bin; the root npm script runs it without a global install.
If you want the bare command on your PATH, build first and explicitly link the daemon workspace
with npm; Legible does not install a global command automatically.
For a disposable, installable local tarball, run `npm run pack:local`. It creates
`dist/legible-legible-<version>.tgz` with the CLI, daemon, web assets, and bundled protocol; the
remaining runtime dependencies are installed by npm. `npm run test:package` packs that build,
installs it in a temporary directory, starts the daemon, checks the web assets, and stops it.
The package is private and is not published; choose a release scope before publishing.
The CLI starts one background daemon if needed, then exits. In a supported checkout it registers the
current repository; outside a checkout it warns and still opens the home screen. Local interactive
runs open the browser automatically; SSH, CI, and non-interactive runs only print the URL. Override
this with `--open` or `--no-open`. Browser-launch failure is non-fatal; open the printed URL manually.
Linux uses `xdg-open`, macOS uses `open`, and WSL uses `wslview` when installed. Native Windows is
not supported; run inside WSL. Do not pass connection URLs to diagnostic logs or issue reports.

```bash
npm run legible -- add ../another-checkout  # register only; paths may be relative
npm run legible -- status                  # never starts a daemon or prints a token
npm run legible -- stop                    # stop only when no work is active
```

`legible pr 123` reopens a saved review (or its submission receipt) directly. For a new PR it fills
the web PR-number field so you can choose agent settings before creating the review. CLI entry never
creates a new review automatically, starts an agent, or submits to GitHub. `add` and `pr` require a
supported checkout; they fail instead of falling back to the home screen.

On the home screen, paste an absolute path to a
local GitHub.com checkout, choose a PR (or enter its number), and select Claude or Codex. Advanced
settings expose model, effort, and supported read-only tool policies. Opening a PR prepares and
saves its pinned diff; **only Start review calls the agent**. Reopening a PR keeps its original
commits, configuration, comments, and conversation. Submitted reviews reopen their receipt.

The home screen shows registered repositories, recent reviews, and setup status. A missing unused
agent does not prevent reviewing with the other one. GitHub requests use your existing `gh` login;
run `gh auth login` if needed, sign in to your selected agent, then refresh Setup.

For development with Vite hot reload:

```bash
LEGIBLE_WEB_ORIGIN=http://127.0.0.1:5173 npm run dev
```

Stop a background daemon before starting this foreground watch command. Both paths use the same
ownership checks; the development daemon will not replace an already running instance. To run the
built daemon in the foreground instead, use `npm start --workspace @legible/daemon` and Ctrl+C to stop.
After startup you can use the CLI to attach to either foreground or background instances. A running
daemon keeps its original environment, browse root, and web origin until you explicitly restart it.

Vite proxies both HTTP and WebSocket traffic. Its port is fixed at 5173; the daemon serves on 7777.
For SSH, forward port 7777 (`ssh -L 7777:127.0.0.1:7777 <host>`) and open the daemon's connection URL
in your local browser. Use the same hostname consistently; `localhost` and `127.0.0.1` have different
browser cookies. The daemon must not be exposed directly to the network.

Repository paths must resolve beneath `LEGIBLE_BROWSE_ROOT`, which defaults to your home directory.
Set it before starting the daemon when checkouts live under another mount. Linked worktrees, bare
repositories, credential-bearing remote URLs, and GitHub Enterprise origins are not supported in
this release. Multiple clones of the same repository are remembered, but the first remains primary.
If it moves or disappears, restore that checkout; Legible will not silently switch clones.

Use **Manage checkouts** on the workspace home screen to inspect registered paths, choose a primary,
or forget a non-primary registration. These actions never delete local checkout files. A primary
change requires a valid matching GitHub origin, no saved sessions (including archived sessions), and
no linked worktrees in the old primary. An unavailable primary must be restored before switching.
The primary itself cannot be forgotten; choose another primary first. Registry updates and review
preparation are serialized so an in-flight review cannot lose its checkout.

When no reviews or linked worktrees depend on a repository, **Remove repository registration**
removes it from Legible without deleting its local checkout.

The registry and sessions are saved under `$XDG_STATE_HOME/legible`, falling back to
`~/.local/state/legible`. Existing session files remain readable; register their matching checkout
before requesting worktree cleanup. Permanent repository/session deletion,
subordinate agents, automatic SSH tunnels, and OS service/autostart installation are not
implemented yet. No package is published by this implementation.

### Directory picker

Choose **Browse folders** on the workspace home screen to find a checkout beneath
`LEGIBLE_BROWSE_ROOT`. You can still paste an absolute path. The picker lists directory names only,
hides hidden folders, `node_modules`, `target`, and symlink entries, and stops at directories containing
`.git`. Choosing a Git folder registers it through the same checkout and GitHub origin checks as the
path input; a linked worktree or unsupported origin will show an error. The returned repository name
comes from the verified `origin` remote.

Each listing shows at most 200 directories after scanning at most 2,000 entries. If the list is
limited, paste a known path. The picker stays within the configured root and cannot open files or
browse below a Git checkout. If the browse root changes, restart the daemon before using it.

### Saved review management

Recent reviews can be filtered by repository and by draft, submitted, pending/uncertain submission,
or archived state. Archived reviews are hidden by default. **Archive** preserves pinned commits,
comments, conversation, submission receipts/history, and worktrees; it does not reclaim disk space.
Active agent turns, refreshes, pending mutations, unresolved submissions, and incomplete cleanup
block archiving. Archived sessions reject review operations until restored.

Use **Restore**, or open an archived item to restore and reopen the same session. A direct archived
review URL shows a restore screen first. Restoring never fetches new commits or starts an agent.
Visibility is saved before broadcasting updates and survives restarts; old session records without
`archivedAt` remain active. **Delete** on an archived review asks for confirmation, then removes its
local record, conversation and clean managed worktree. It never deletes the GitHub review or local
repository checkout. Dirty or unsafe worktrees block deletion; the pending request stays visible
for retry, including after a daemon restart.

### Refresh and review again

Use **Check for updates** to compare the pinned HEAD and target branch with GitHub, then **Refresh
PR** to load the latest entire PR diff. Nothing is polled, and refreshing never calls a model. Stop
any active turn first; then choose **Review again** or send a message explicitly. The session URL,
agent settings, drafts, and conversations are retained. Refresh clears obsolete file selections and
caches while preserving unsent comment/chat text.

Comments move automatically only when their unchanged location can be verified. Edited, deleted,
ambiguous, or no-longer-visible anchors appear in **Comments needing location review**, not on a
possibly incorrect line. Choose a new location and confirm it, or delete the draft, before submission.
After a successful submission and worktree cleanup, **Continue reviewing** opens a fresh draft in
the same session. Previous receipts, pinned commits, comments, and conversations remain read-only
history; previously submitted comments are never automatically submitted again.

Refresh prepares a separate worktree generation and saves the session plus chat atomically. If
preparation or saving fails, the previous review remains intact. Cleanup failures retain the old
worktree and display a warning; safe retention cleanup can remove it later. Dirty worktrees and
configuration recovery conflicts are never forcibly overwritten.

### Code search

Use **Find in view** or **Ctrl/Cmd+F** to search the displayed diff or whole file. Searches are
case-sensitive literal text. Enter/F3 moves forward, Shift+Enter/Shift+F3 moves backward, and Escape
closes the find input. The first 1,000 occurrences are highlighted; narrow the query if capped.

The **Code search** sidebar searches all regular tracked files at the session's pinned HEAD,
including unchanged files. Search is explicit (Enter or **Search code**) and never calls a model or
GitHub. Click a result to open the pinned file at its real line number. Files remain read-only;
only existing diff hunk lines have comment buttons. Return with **Diff** or **Changed files**.
Unsent comment text and chat remain intact while browsing search results. Refreshing the PR clears
search results and open search previews; cancelled or obsolete responses cannot replace the new view.

Search excludes symlinks, submodules, binary files, and untracked files. Files over 1 MiB are skipped
and counted. Results are capped at 200 matching lines (400-character previews), with a 5-second
budget and 2 MiB of grep output. A limit notice means results may be incomplete. Repository tree
enumeration is capped at 8 MiB and fails explicitly if incomplete. There is one active search/read
per session and at most four daemon-wide; busy requests can be retried. Queries are single-line,
case-sensitive literals up to 256 UTF-8 bytes. File previews require UTF-8 text. Search does not use
local working-copy edits or expose arbitrary filesystem paths, and runs no text conversion filters.

## Daemon lifecycle

The daemon must own both port 7777 and the private `daemon.sock` in its state directory **before**
restoring sessions, recovering projected configuration, or sweeping worktrees. Concurrent commands
attach to the same instance. Startup and shutdown reject ordinary HTTP/WebSocket traffic with 503.
There is no random-port fallback and no automatic restart for an incompatible daemon version.
If another program owns the port, Legible reports the conflict without stopping that program.

`legible stop` refuses while a mutation, Git operation, or agent turn is active. Wait for the work to
finish (or interrupt the turn in the web UI) and retry. An idle stop closes agent processes, restores
projected configuration, and persists conversations before releasing ownership. Errors during cleanup
or persistence make stop fail visibly; inspect the log before restarting. SIGINT/SIGTERM use the same
cleanup path and preserve interrupted turns for retry. Neither stop nor attach deletes saved reviews.

Background diagnostics append to `daemon.log` in the state directory (mode 0600). The directory is
private (0700), and the control socket is 0600. Bootstrap tokens stay in memory and travel only over
the private control connection and the printed browser URL, never through the log or a credentials
file. Existing unsafe socket paths or log symlinks are rejected. A stale socket left by a crash is
reclaimed only after acquiring the HTTP port and verifying that no live control server owns it.

CLI startup and stop wait up to 30 seconds. A timeout does not kill a process: inspect `legible status`
and `daemon.log` before retrying. Keep the state path short enough for a Unix socket (the full
`daemon.sock` path must fit in 103 UTF-8 bytes). There is no previous published release or
backward-compatibility guarantee for the rewrite.

`npm run check` runs unit/process tests, builds the application, then runs `npm run test:cli` against
the built executable with temporary repositories and fake vendor probes. The final smoke test needs
port 7777; it skips without touching the listener if that port is already occupied. Ordinary process
tests use ephemeral ports. CI runs both Linux and macOS; WSL opener selection is unit-tested, but
launching a Windows browser still requires a WSL environment for manual verification.

## Browser access and daemon API

The connection URL contains a temporary bootstrap token in its fragment. The app removes it from
the address bar and exchanges it for an HttpOnly, SameSite=Strict cookie. Treat the URL as a secret:
it grants access to local reviews and user-triggered agent/GitHub actions. Tokens change on restart;
use the newly printed URL to reconnect. No GitHub or agent credential is sent to the browser.
The cookie protects API reads, mutations, and WebSocket connections even on localhost. Agent MCP
tokens are separate and cannot authenticate browser APIs. No cloud hosting or public sign-in is used.

The main entry endpoints are:

- `GET /api/repos`, `POST /api/repos` with `{ "path": "/absolute/checkout" }`
- `GET /api/repos/:owner/:name/pulls?page=1` (30 open PRs per page, recently updated first)
- `POST /api/sessions` with `{ repoId, prNumber, config }`, returning `{ session, reused }`
- `POST /api/sessions/:sessionId/open` to update its recent-review timestamp

API clients must first exchange the printed token at `POST /api/auth`, retain the response cookie,
and send a matching local `Origin` on mutations. Browser traffic handles this automatically.

The daemon binds to `127.0.0.1:7777`. Run it directly during daemon work:

```bash
npm run dev --workspace @legible/daemon
```

It currently provides health and preflight status, preflight refresh, persisted review sessions,
a normalized session diff, restricted whole-file content, and a read-only WebSocket event stream
under `/api`. Session diffs are available from `GET /api/sessions/:sessionId/diff`; the web review
screen uses `GET /api/sessions/:sessionId/file?path=...&side=RIGHT` for its whole-file toggle. That
endpoint accepts only paths and sides present in the session diff, so it cannot act as a general
file browser. Missing tools or authentication place the daemon in degraded mode without preventing
the status API from starting.

`GET /api/sessions/:sessionId/updates` checks GitHub metadata; `POST .../refresh` verifies fetched
head/base revisions and updates the session. `POST .../comments/:commentId/reanchor` accepts a new
path, side, line, and optional same-side range. Session-scoped diff/file/chat/comment/submission and
refresh requests send `x-legible-review-revision` from the rendered session (the Node baseline
treats a missing header as revision 0). Stale requests receive 409; refetch the session before
retrying. MCP leases are likewise revision-bound. The Node baseline writes v3 records; the Rust
store uses its own current format and does not inherit Node's legacy readers.

`GET /api/sessions/:sessionId/search?q=...` returns pinned-HEAD paths, line numbers, previews, revision,
and truncation/skipped-file information. `GET .../search/file?path=...` opens a regular tracked HEAD
blob, including files outside the diff. Both use the same browser authentication and review revision
header; neither accepts a caller-provided SHA or filesystem root. The existing `/file` endpoint and
comment validation remain diff-restricted. HTTP cancellation stops the active search Git process.

`GET /api/directories` starts at the configured browse root. An optional absolute `path` query lists
one child directory with `root`, `path`, `parent`, `repository`, directory-only `entries`, and
`truncated`. It uses the existing browser authentication; registration still goes through
`POST /api/repos` and independently revalidates the selected path.

`POST /api/sessions/:sessionId/archive` accepts `{ "archived": true | false }` and requires the
rendered review revision. `/open` also restores archived sessions. Lists and snapshots include archived
records so clients can filter them. `GET /api/repos/:owner/:name/checkouts` reports validated path
availability and dependency restrictions; `PATCH .../primary` and `DELETE .../checkouts` take an exact
registered `{ "path": "..." }`. All management routes require the existing browser authentication.
`DELETE /api/sessions/:sessionId/delete` requires the rendered revision and a previously archived
review. `DELETE /api/repos/:owner/:name` removes only an unused repository registration.

Open `/review/:sessionId` in the web app to view a unified, read-only CodeMirror diff. Changed-file
navigation, left/right line anchors, whole-file context, loading, empty, binary, and API error states
are available alongside inline drafts, review submission, and main/per-comment Codex or Claude chats.

Claude uses the official Agent SDK with the locally installed, unmodified `claude` executable.
Its initial scope is `shell: none`, `network: off | fetch`, and `onOutOfScope: deny`; subordinate
agents are not enabled yet. Only read/search tools and Legible's review MCP tools are available.
Hooks, executable skills, slash commands, and plugins are disabled for reviews. Incompatible
managed customizations block startup. Base-branch executable configuration remains projected until
the agent exits; restoration conflicts block reuse and cleanup without overwriting user edits.

Legible delegates authentication to the locally installed agent CLIs. Sign in before starting the
daemon:

```bash
claude auth login
codex login
```

Preflight checks `claude auth status` and `codex login status`. Subscription or API billing is chosen
inside each official CLI; Legible never reads or stores agent credentials. Claude's chat reports
the CLI's authentication category, not a guarantee of free or subscription-only usage. In particular,
an inherited `ANTHROPIC_API_KEY` can select API billing even when a subscription is active.

Run the optional local Claude startup/shutdown smoke test without a model prompt:

```bash
LEGIBLE_CLAUDE_INTEGRATION=1 npx vitest run apps/daemon/src/agents/claude/integration.test.ts
```

The daemon also owns the internal PR worktree lifecycle. It creates detached worktrees outside
the checkout, reuses their pinned commits, refuses destructive cleanup of dirty or unknown paths,
and sweeps inactive worktrees after 14 days. Preparation verifies fetched PR head and base against
GitHub metadata, computes merge-base, and serializes Git operations per clone. Changed PRs, missing
history, dirty worktrees, and unexpected paths fail safely instead of resetting or deleting data.
