# Contributing

Thanks for taking an interest. Bug reports, small fixes and test improvements
are all welcome. For larger changes, open an issue first so we can agree on the
approach.

## Setup

Follow [Local development](README.md#local-development) in the README. You need
Node.js 22 or later and npm. `npx convex dev` can run an anonymous local backend,
so no Convex account is required.

## Before opening a pull request

Run the same checks as CI:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

If you touch UI flows, also run `npm run test:e2e`. It builds the app and starts
a local Convex backend, and refuses to run against a cloud deployment.

## Guidelines

- The server owns game state. Gameplay changes go through the pure reducer in
  `convex/lib/game/`, which must not read `Date` or `Math.random` (lint enforces
  this), and through `commitEvents` in `convex/lib/gameStore.ts`.
- Add or update tests next to the code you change: `tests/game/` for the reducer,
  `tests/convex/` for Convex functions, `tests/ui/` for components and `e2e/` for
  browser flows.
- Coverage floors in `vitest.config.mts` only go up.
- Never commit `.env*` files other than `.env.local.example`, or any key or token.
  CI runs a gitleaks scan on every push.
- Keep pull requests focused, and describe what changed and how you tested it.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
