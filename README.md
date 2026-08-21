# Legible

Legible is an AI-assisted GitHub pull request review tool built as a local daemon and a
browser UI. The project is currently at the repository-scaffolding stage; see
[`DESIGN.md`](./DESIGN.md) for the product and architecture specification.

## Development

Use Node.js 24 and npm 11. With `nvm`, run:

```bash
nvm use
npm ci
```

The repository is an npm workspace with separate browser, daemon, and shared-code packages.

| Command          | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `npm run dev`    | Watch shared types and the daemon while running the Vite dev server |
| `npm run build`  | Build shared, daemon, and web workspaces in dependency order        |
| `npm test`       | Run the Vitest suite                                                |
| `npm run lint`   | Run ESLint with warnings treated as errors                          |
| `npm run format` | Format supported files with Prettier                                |
| `npm run check`  | Run formatting, linting, tests, and the production build            |

The current application entrypoints are deliberately empty. Product behavior begins with the
daemon skeleton described in the implementation order in `DESIGN.md`.
