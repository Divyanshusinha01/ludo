# Family Ludo

2–4 player online Ludo for phones. Next.js + Convex realtime. No accounts — just room codes.

## Stack

- Next.js (App Router) + TypeScript
- React + CSS/SVG board
- Convex (authoritative game state + realtime)
- Vercel for hosting

## Local development

1. Install dependencies: `npm install`
2. Log in to Convex: `npx convex dev` (creates `.env.local` with `NEXT_PUBLIC_CONVEX_URL`)
3. In another terminal: `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000)

## Event log and replay (dev)

Gameplay mutations append to the `gameEvents` table and require `expectedSeq` from the client (`room.eventSeq`). Legacy rooms without `eventSeq` are rejected — run `npx convex run legacy:purgeLegacyRooms` once after deploying the schema.

Turn expiry: if a command arrives after the turn clock, the server commits timeout events first and returns `turnExpired` on roll (no thrown mutation, so the timeout persists).

Debug replay UI: `/debug/replay/[CODE]` in development, or set `NEXT_PUBLIC_ENABLE_REPLAY_DEBUG=1` in production.

## Operations

[docs/operations.md](docs/operations.md) covers the version and reconnect model, metrics and the `/ops` dashboard, k6 load tests with measured results, and troubleshooting.

Ops dashboard: `/ops` in development, or set `NEXT_PUBLIC_ENABLE_OPS_DASHBOARD=1` in production. It also needs the `OPS_DASHBOARD_TOKEN` Convex environment variable (`npx convex env set OPS_DASHBOARD_TOKEN <value>`).

## Scripts

- `npm run dev` — Next.js frontend
- `npm run dev:convex` — Convex backend watcher
- `npm test` / `npm run test:logic` — all Vitest projects (unit, Convex, UI)
- `npm run test:unit` / `test:convex` / `test:concurrency` / `test:ui` — one project or folder
- `npm run test:watch` — Vitest watch mode
- `npm run typecheck` — TypeScript for the app and `convex/`
- `npm run test:integration` — live Convex smoke (needs `.env.local`)
- `npm run test:full-game` — plays a full game against the live backend
- `npm run load:gameplay` / `load:reconnect` — k6 load tests against the local backend (needs [k6](https://k6.io), `winget install k6`)
- `npm run load:verify` — `verifyReplay` on a sample of rooms after a load run
- `npm run build` — production Next.js build

### Mobile QA checklist

- Safe-area padding on notched phones (home indicator not covering Leave / CTAs)
- Share sheet / copy room code from lobby
- Two tokens on one cell fan out (barrier / safe stacks are tappable)
- Leave during play returns home and forfeits the seat
- Create game submits with Enter from the name field
- Away-player banner when the current turn seat is disconnected
- Home-screen install tip appears on phones (dismissible)
- Haptics (where supported) on roll / capture / win

## Deploy (production — phones need Convex cloud)

Local anonymous Convex (`127.0.0.1`) only works on this machine. For family phones:

```bash
# 1. Link a Convex cloud account (interactive once)
npx convex login

# 2. Create/link a cloud project and deploy backend
npx convex deploy

# 3. Note the production URL printed (also in the Convex dashboard)
# 4. Deploy frontend to Vercel with that URL:
npx vercel --prod
# Set NEXT_PUBLIC_CONVEX_URL to the Convex production URL in the Vercel project env
```

Or one-shot Convex+build:

```bash
npx convex deploy --cmd "npm run build"
```

Then import the repo in Vercel and set `NEXT_PUBLIC_CONVEX_URL`.

## How to play

1. One person taps **Create game** and shares the 6-character code (or uses Copy / share)
2. Others **Join game** with the code (2–4 players)
3. Host starts when at least two players are in the lobby
4. On your turn: roll the dice, tap a glowing token to move
5. After a win: **Play again** for a rematch, or go home

### Rules implemented

- Need a **6** to leave home
- Exact count to finish
- Capture opponents on non-safe cells (sent home)
- Safe cells: start squares + star cells
- **Barrier**: two tokens of the same colour on one cell cannot be captured or landed on. Tokens may still pass through a barrier cell mid-path (destination-only block)
- Extra turn on **6** or capture
- Three consecutive 6s skips the turn
- Away players are skipped after ~60s; leaving mid-game forfeits your seat (if only one player remains, they win)
- Finished rooms expire ~6h after the win; idle/abandoned playing rooms are cleaned up automatically
- Rematch is host-only and drops long-away seats
- First player to finish all four tokens wins

### Privacy

Your session id stays in this device’s browser storage and is never returned to other players in room queries. Session ids must be valid UUIDs; room creation is lightly rate-limited.
