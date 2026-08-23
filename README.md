# Legible

Legible is an AI-assisted GitHub pull request review tool built as a local daemon and a
browser UI. The daemon skeleton is under active development; see [`DESIGN.md`](./DESIGN.md) for
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

## Daemon API

The daemon binds to `127.0.0.1:7777`. Run it directly during daemon work:

```bash
npm run dev --workspace @legible/daemon
```

It currently provides health and preflight status, preflight refresh, an in-memory session list,
a normalized session diff, restricted whole-file content, and a read-only WebSocket event stream
under `/api`. Session diffs are available from `GET /api/sessions/:sessionId/diff`; the web review
screen uses `GET /api/sessions/:sessionId/file?path=...&side=RIGHT` for its whole-file toggle. That
endpoint accepts only paths and sides present in the session diff, so it cannot act as a general
file browser. Missing tools or authentication place the daemon in degraded mode without preventing
the status API from starting.

Open `/review/:sessionId` in the web app to view a unified, read-only CodeMirror diff. Changed-file
navigation, left/right line anchors, whole-file context, loading, empty, binary, and API error states
are available alongside inline drafts, review submission, and main/per-comment Codex chats.

Legible delegates authentication to the locally installed agent CLIs. Sign in before starting the
daemon:

```bash
claude auth login
codex login
```

Preflight checks `claude auth status` and `codex login status`. Subscription or API billing is chosen
inside each official CLI; Legible never reads or stores agent credentials.

The daemon also owns the internal PR worktree lifecycle. It creates detached worktrees outside
the checkout, reuses their pinned commits, refuses destructive cleanup of dirty or unknown paths,
and sweeps inactive worktrees after 14 days. Review creation will expose this capability in a
later implementation step.
