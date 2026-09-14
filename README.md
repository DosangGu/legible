# Legible

Legible is an AI-assisted GitHub pull request review tool built as a local daemon and a
browser UI. The review workflow is under active development; see [`DESIGN.md`](./DESIGN.md) for
the product and architecture specification.

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
| `npm test`       | Run the Vitest suite                                                  |
| `npm run lint`   | Run ESLint with warnings treated as errors                            |
| `npm run format` | Format supported files with Prettier                                  |
| `npm run check`  | Run formatting, linting, tests, and the production build              |

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

The registry and sessions are saved under `$XDG_STATE_HOME/legible`, falling back to
`~/.local/state/legible`. Existing session files remain readable; register their matching checkout
before requesting worktree cleanup. PR refresh/new review of an already reviewed PR, the folder
picker, subordinate agents, automatic SSH tunnels, and OS service/autostart installation are not
implemented yet. No package is published by this implementation.

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
`daemon.sock` path must fit in 103 UTF-8 bytes). State files and the browser authentication contract
remain compatible with the previous release.

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
