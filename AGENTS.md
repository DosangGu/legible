# Repository Guidelines

## Project Structure & Module Organization

This npm workspace is the current implementation. `apps/daemon` contains the feature-grouped Node daemon, `apps/web` contains the Vite/React SPA, and `packages/protocol` contains browser-safe HTTP/WebSocket types and domain models. Tests live beside source as `*.test.ts` or `*.test.tsx`; shared fixtures belong in `src/testing/` and are excluded from production builds. Generated output belongs in each workspace's `dist/`. `DESIGN.md` remains the authoritative architecture specification, including the planned standalone Rust daemon, desktop window, and future VS Code client. Do not treat that target architecture as already implemented.

The root Cargo workspace contains Rust wire models in `crates/protocol` and domain services plus a binary scaffold in `crates/daemon`; `apps/desktop` will be added later. The Rust session store uses one current format (`version: 1`) without legacy readers. Its session service provides read-only registry access, durable-before-publish mutations, and interrupted-chat recovery. `crates/daemon/src/api` adds an authenticated read-only Axum application and loopback listener helper, but the binary still does not serve HTTP or load live state. WebSocket delivery and production lifecycle are not implemented in Rust yet. Keep the daemon independent of desktop GUI dependencies. React and future TypeScript clients retain npm tooling. The Node daemon is still the runnable application while Rust is incomplete. Rust output belongs in `target/`.

Legible has not been released. Do not add backward-compatibility layers or preserve historical Node API/state formats during the Rust rewrite. Update current schemas, clients, and tests together as needed. Compatibility policy is deferred until release planning; this does not permit deleting a contributor's local data.

## Build, Test, and Development Commands

Use Node 24 (`nvm use`) and install the locked dependencies with `npm ci`. Key root commands are:

```bash
npm run dev           # watch shared/daemon code and run Vite
npm run build         # build protocol, daemon, then web
npm test              # run Vitest once
npm run lint          # run ESLint with zero warnings
npm run format:check  # verify Prettier formatting
npm run check         # run every CI validation
```

Run workspace-specific commands with `npm run <script> --workspace @legible/<name>`. The current CLI exposes `legible`, `legible pr <number>`, and `legible add <path>`.

For Rust, run `cargo check --workspace --locked`, `cargo test --workspace --locked`, `cargo fmt --all -- --check`, and `cargo clippy --workspace --all-targets --locked -- -D warnings`. `rust-toolchain.toml` selects the toolchain and components. CI checks both workspaces. Rust protocol tests consume the same JSON fixture as the TypeScript contract test; regenerate it with `npm run fixtures:write --workspace @legible/protocol` when its type-checked source changes.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and no semicolons; Prettier owns formatting. ESLint and strict TypeScript must pass without warnings. Use `PascalCase` for types and React components and `camelCase` for variables, functions, and fields. Keep vendor schemas inside adapters and expose normalized interfaces to core code. Use lowercase `legible` for commands, packages, identifiers, and paths; use `Legible` in prose.

For Rust, rustfmt owns formatting; use `snake_case` for functions and fields and `PascalCase` for types. Use camelCase JSON keys and explicit discriminator values through Serde attributes; update current clients and fixtures together when changing the contract. Commit the root `Cargo.lock`, and keep shared dependency versions and lints in the root workspace manifest.

### Readability & Function Boundaries

Apply these rules to both Rust and TypeScript. Keep formatter checks passing, but do not rely on
automatic formatting alone to make code readable.

- Separate logical steps with blank lines, especially setup, validation, state changes, and results.
- Split long literals and complex expressions across lines. Use named intermediate values instead
  of embedding long builder chains or multiple operations inside another call.
- Keep each function focused on one cohesive responsibility. Extract meaningful operations and
  repeated logic into clearly named functions; do not split functions solely to meet a line count.
- Prefer guard clauses and straightforward control flow over deeply nested conditionals or closures.
- Share repeated test setup and request/response handling, while keeping scenario-specific inputs
  and assertions visible in each test. Do not fragment obvious one-step operations into helpers.

## Testing Guidelines

Vitest is the test runner. New behavior must include focused tests named after observable outcomes. Prioritize diff line/side accounting, path normalization, worktree cleanup, persistence, adapter event normalization, and stale GitHub comment anchors. Keep fixtures small and deterministic. There is no coverage threshold yet; do not use that as a reason to leave critical branches untested.

Rust domain tests use `cargo test`. Rust storage fixtures live in `crates/daemon/tests/fixtures/session-records.json` and validate the current schema, not Node compatibility. Keep strict validation and atomic-write/permission tests when changing storage. Keep all storage tests isolated in temporary directories; do not point rewrite tests at a contributor's real state.

Session mutations must persist before publishing memory changes/events, and failed removals must retain registry ownership. Recovery must never start agents or rewrite files during initialization; checkpoint it explicitly after successful startup/shutdown. Keep revision guards and failure/restart tests when adding asynchronous transport or scheduling.

Preserve direct browser access with one HTTP/JSON command/read API and a WebSocket event contract for all client hosts. Rust API tests use temporary state and explicit readiness, never a real state root. Require explicit safe review revisions on scoped reads, retain archived/deleting records as read-only, and keep bootstrap, browser-cookie, and future MCP credentials separate. Do not add CORS shortcuts or bypass local Host/Origin checks for desktop/editor clients; their connection adapters belong outside review UI components.

## Commit & Pull Request Guidelines

Use short, imperative Conventional Commit subjects, for example `docs: clarify worktree lifecycle` or `feat: parse unified diffs`. Keep commits focused. Pull requests should explain the user-visible outcome, call out deviations from `DESIGN.md`, list verification performed, and link relevant issues. Include screenshots for web UI changes and sample fixtures for parser changes.

## Security & Configuration

Never commit tokens or modify a contributor's Claude, Codex, or GitHub configuration. Preserve the design constraints: bind locally by default, keep agents read-only, keep credentials in the daemon, and use base-branch versions of executable agent configuration when reviewing pull requests.
