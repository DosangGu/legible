# Repository Guidelines

## Project Structure & Module Organization

This repository is in the design phase. `DESIGN.md` is the authoritative product and architecture specification; no source, tests, or assets exist yet. The planned system has a TypeScript/Node daemon, Vite/React SPA, shared types, GitHub integration, and isolated Claude/Codex adapters. Keep those boundaries visible in the initial layout, and update `DESIGN.md` when implementation changes an architectural decision.

## Build, Test, and Development Commands

There is no `package.json`, build pipeline, or test runner yet. For documentation-only changes, run:

```bash
git diff --check       # detect whitespace errors
git status --short     # confirm the intended files changed
```

When introducing the Node toolchain, provide `dev`, `test`, `lint`, and `build` scripts and document them in the same pull request. The eventual CLI should expose `legible`, `legible pr <number>`, and `legible add <path>`.

## Coding Style & Naming Conventions

Follow the TypeScript examples in `DESIGN.md`: two-space indentation, single quotes, `PascalCase` for types and React components, and `camelCase` for variables, functions, and fields. Keep vendor schemas inside adapters; core code should use normalized interfaces. Use lowercase `legible` for commands, packages, identifiers, and paths; use `Legible` in prose. No formatter or linter is configured, so document one when adding it.

## Testing Guidelines

No framework or coverage threshold has been selected. New executable code should include automated tests. Prioritize diff line/side accounting, path normalization, worktree cleanup, persistence, adapter event normalization, and stale GitHub comment anchors. Name tests after observable behavior, keep fixtures small, and expose the full suite through `npm test`.

## Commit & Pull Request Guidelines

Recent history favors short, imperative subjects; use Conventional Commit prefixes where useful, for example `docs: clarify worktree lifecycle` or `feat: parse unified diffs`. Keep commits focused. Pull requests should explain the user-visible outcome, call out deviations from `DESIGN.md`, list verification performed, and link relevant issues. Include screenshots for web UI changes and sample diff fixtures for parser changes.

## Security & Configuration

Never commit tokens or modify a contributor's Claude, Codex, or GitHub configuration. Preserve the design constraints: bind locally by default, keep agents read-only, keep credentials in the daemon, and use base-branch versions of executable agent configuration when reviewing pull requests.
