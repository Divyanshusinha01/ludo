# Quality scorecard

Every number here was produced by the command next to it, on the date and
machine given. Failed thresholds stay listed as failures. Raw outputs are
written to `load/results/` (gitignored).

Machine for every local run: Intel Core i5-13500H (12 cores, 16 threads),
15.7 GB RAM, Windows 11 Home, Node 24.19.0.

## Summary (2026-10-11)

| Measure | Result | Command |
| --- | --- | --- |
| Vitest | 730 of 730 tests pass, 62 files | `npm run test:coverage` |
| Line / branch / function coverage | 82.52% / 73.49% / 85.39% (Vitest 4) | `npm run test:coverage` |
| Playwright E2E | 8 tests in 7 specs; see the CI run for the current result | `npx playwright test` |
| axe (WCAG A/AA) | 0 serious or critical violations on 5 screens | `e2e/a11y.spec.ts` |
| Bot vs random-legal player | 171 of 200 1v1 games won (85.5%) | `tests/game/bot/bot-strength.test.ts` |
| k6 latency thresholds (p95 < 500ms, p99 < 1000ms) | Pass at 5 rooms, fail from 25 rooms up (local laptop backend) | `load/k6/gameplay.js`, `reconnect.js` |
| k6 reconnect success | 100% at 5 and 25 rooms, 99.77% at 50, 99.49% at 100 | `load/k6/reconnect.js` |
| `verifyReplay` | 59 of 59 checked rooms with no diffs | `npm run load:verify` |
| Lighthouse mobile, live demo (median of 3) | Performance 90, Accessibility 100, Best practices 96, SEO 100 | `npx lighthouse@12` |
| Cloud Convex load | Not measured | |

## Tests and coverage

Command: `npm run test:coverage` (Vitest 4.1, `@vitest/coverage-v8`), all three
projects (unit, convex via `convex-test`, ui). Exit 0 in 292s.

| Metric | Covered | Total | % | CI floor |
| --- | --- | --- | --- | --- |
| Statements | 3764 | 4739 | 79.42 | 77.5 |
| Branches | 2213 | 3011 | 73.49 | 71 |
| Functions | 807 | 945 | 85.39 | 83.5 |
| Lines | 3354 | 4064 | 82.52 | 80.5 |

- Scope: `convex/lib/**`, `convex/*.ts` and `src/lib/**`, excluding
  `convex/_generated`. React components are tested by the `ui` project but are
  not in the coverage total.
- Vitest 4 maps v8 coverage through the AST, which counts statements and
  branches differently from Vitest 3. On the same code it reported lines 82.16,
  statements 79.10, branches 72.57 and functions 85.18, against 84.68 / 84.68 /
  85.47 / 89.42 under Vitest 3. The drop is in the measurement, not the tests.
- The CI floors in `vitest.config.mts` sit about 1.5 points under that Vitest 4
  baseline. They only ever go up.

## Browser E2E (Playwright)

Command: `npx playwright test` (`npm run test:e2e`), Chromium, against
`next start` and a throwaway local Convex backend. One worker, retries off.

| Spec | Checks |
| --- | --- |
| `bot-game.spec.ts` | A guest creates a room, adds a computer, rolls, moves a token by mouse, and the computer takes its turn |
| `two-player.spec.ts` | Two browser contexts join by code, play 8 turns, and end with identical move logs |
| `reconnect.spec.ts` | A seat goes offline ("Reconnecting…"), the other seat plays, and the dropped seat catches up and acts again with no page reload |
| `pwa-offline.spec.ts` | After the service worker installs, `/offline` loads with the network cut and a pass-and-play game starts and rolls |
| `keyboard.spec.ts` | Start, roll and move a token with Tab and Enter only, with a visible focus ring |
| `a11y.spec.ts` | axe finds no serious or critical WCAG A/AA violations on home, offline setup, offline game, online lobby and online game |
| `security-headers.spec.ts` | The home page carries the security headers, and home plus an offline game report no Content Security Policy violations |

- Result before `security-headers.spec.ts` was added: 7 of 7 tests passed in each of 3 consecutive full runs, each from a
  fresh build. Earlier attempts were flaky and found three app bugs (no
  keyboard play, an offline crash when the 3D chunk was not cached, and a stuck
  die); those were fixed before the 3 clean runs.
- The specs run one at a time with reduced motion (2D tokens). With two workers
  and WebGL, the local backend sometimes passed its 1s query limit.
- `reconnect.spec.ts` does not assert the "Board updated" banner. That banner
  only appears when the server rejects an action sent from an outdated view, and
  an offline seat cannot send one. The stale-rejection path is covered on the
  server by `tests/convex/versioning.test.ts` and the k6 reconnect storms.

## Bot strength

Command: `npx vitest run tests/game/bot/bot-strength.test.ts`. 200 seeded 1v1
games of the heuristic bot (`convex/lib/bot.ts`) against a player that picks a
uniformly random legal move, alternating seats. The bot won 171 of 200 (85.5%).
The test fails below 75%. This measures the bot against random play only, not
against people.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) has four jobs:
production dependency audit, lint, typecheck and build; a gitleaks secret scan
over the full history; tests with coverage (uploads the `coverage/` report); and
Playwright E2E on an anonymous local Convex backend (uploads the trace and
report on failure). The README badge shows the current status of `main`.

### Dependency audit (2026-10-11)

`npm audit --omit=dev` reports 0 vulnerabilities. The full `npm audit` reports
5 high findings, all one chain: `braces` (stack exhaustion on deeply nested
glob patterns) via `micromatch` and `fast-glob` inside `eslint-config-next`.
No fixed `braces` release exists yet, and the chain only runs at lint time on
this repo's own files, so it is accepted until upstream ships a fix.

## Load and replay

The full table and method are in
[operations.md](operations.md#2026-10-11-step-up-5-25-50-100-rooms). The backend
was a fresh anonymous local Convex deployment on the same laptop, with k6 v2.2.0.

### k6 load tests

Command: `k6 run -e ROOMS=<n> load/k6/gameplay.js` and `load/k6/reconnect.js`,
2 minutes, 4 players per room, `THINK_MS=250`. Thresholds: mutation p95 < 500ms,
p99 < 1000ms, errors < 1%, reconnect success ≥ 99%.

| Rooms | Gameplay p95 / p99 (ms) | Gameplay errors | Reconnect p95 / p99 (ms) | Reconnect errors | Reconnect success | Thresholds |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 384 / 462 | 0.00% | 119 / 257 | 0.00% | 100% (480/480) | Pass |
| 25 | 1460 / 2477 | 0.06% | 4668 / 11519 | 0.00% | 100% (272/272) | Fail (latency) |
| 50 | 5088 / 8269 | 0.00% | 5864 / 8193 | 1.15% | 99.77% (439/440) | Fail (latency; errors in reconnect) |
| 100 | 13232 / 16933 | 52.32% | 10042 / 13929 | 11.00% | 99.49% (390/392) | Fail (latency, errors) |

The errors are HTTP 429, 503 and dropped requests from the overloaded laptop
backend, not game rejections. Cloud Convex has not been measured.

### Replay consistency

Commands, run after the k6 runs against the same backend:
`POOL=1000 npm run load:verify 40` and `ORDER=asc POOL=300 npm run load:verify 20`.

- 59 of 59 checked rooms replayed with no diffs (heads up to 242; lobby,
  playing and finished rooms).
- One more sampled room had been deleted by `cleanup.tick` before it was
  checked, so the first command reported 39/40.

## Lighthouse (live demo)

Command: `npx lighthouse@12 https://ludo-three-steel.vercel.app --output=json`
(Lighthouse 12.8.2, default mobile form factor with simulated throttling,
headless Chrome 154, same laptop). This measures the deployed site, not the
local working tree. Three valid runs; a fourth failed with `NO_FCP` (headless
paint error) and is excluded.

| Category | Run 1 | Run 2 | Run 3 | Median |
| --- | --- | --- | --- | --- |
| Performance | 90 | 89 | 91 | 90 |
| Accessibility | 100 | 100 | 100 | 100 |
| Best practices | 96 | 96 | 96 | 96 |
| SEO | 100 | 100 | 100 | 100 |

- Median metrics: FCP 1.0s, LCP 2.8s, TBT 290ms, CLS 0.005.
- The best-practices deduction is a console error from the 401 that
  `/api/auth/token` returns to a signed-out visitor.
- PWA: Lighthouse 12 no longer has a PWA category, so there is no Lighthouse
  PWA score. Offline behaviour is covered by `e2e/pwa-offline.spec.ts`.
