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

For the built application:

```bash
npm run build
npm start --workspace @legible/daemon
```

Open the connection URL printed by the daemon. On the home screen, paste an absolute path to a
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
picker, subordinate agents, and the eventual `legible` CLI are not implemented yet.

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
