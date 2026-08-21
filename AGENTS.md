# Repository Guidelines

## Project Structure & Module Organization

This npm workspace separates runnable applications from reusable code. `apps/daemon` contains the Node daemon, `apps/web` contains the Vite/React SPA, and `packages/shared` contains browser-safe shared types and protocols. Tests live beside source as `*.test.ts` or `*.test.tsx`. Generated output belongs in each workspace's `dist/`. `DESIGN.md` remains the authoritative product and architecture specification; update it when implementation changes a documented decision.

## Build, Test, and Development Commands

Use Node 24 (`nvm use`) and install the locked dependencies with `npm ci`. Key root commands are:

```bash
npm run dev           # watch shared/daemon code and run Vite
npm run build         # build shared, daemon, then web
npm test              # run Vitest once
npm run lint          # run ESLint with zero warnings
npm run format:check  # verify Prettier formatting
npm run check         # run every CI validation
```

Run workspace-specific commands with `npm run <script> --workspace @legible/<name>`. The eventual CLI will expose `legible`, `legible pr <number>`, and `legible add <path>`.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and no semicolons; Prettier owns formatting. ESLint and strict TypeScript must pass without warnings. Use `PascalCase` for types and React components and `camelCase` for variables, functions, and fields. Keep vendor schemas inside adapters and expose normalized interfaces to core code. Use lowercase `legible` for commands, packages, identifiers, and paths; use `Legible` in prose.

## Testing Guidelines

Vitest is the test runner. New behavior must include focused tests named after observable outcomes. Prioritize diff line/side accounting, path normalization, worktree cleanup, persistence, adapter event normalization, and stale GitHub comment anchors. Keep fixtures small and deterministic. There is no coverage threshold yet; do not use that as a reason to leave critical branches untested.

## Commit & Pull Request Guidelines

Use short, imperative Conventional Commit subjects, for example `docs: clarify worktree lifecycle` or `feat: parse unified diffs`. Keep commits focused. Pull requests should explain the user-visible outcome, call out deviations from `DESIGN.md`, list verification performed, and link relevant issues. Include screenshots for web UI changes and sample fixtures for parser changes.

## Security & Configuration

Never commit tokens or modify a contributor's Claude, Codex, or GitHub configuration. Preserve the design constraints: bind locally by default, keep agents read-only, keep credentials in the daemon, and use base-branch versions of executable agent configuration when reviewing pull requests.
