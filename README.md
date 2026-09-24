# Family Ludo

4-player online Ludo for phones. Next.js + Convex realtime. No accounts — just room codes.

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

## Scripts

- `npm run dev` — Next.js frontend
- `npm run dev:convex` — Convex backend watcher
- `npm run test:logic` — pure Ludo rules unit checks
- `npm run build` — production Next.js build

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

1. One person taps **Create game** and shares the 6-digit code
2. Three others **Join game** with the code (max 4)
3. Host starts when all four are in the lobby
4. On your turn: roll the dice, tap a glowing token to move

### Rules implemented

- Need a **6** to leave home
- Exact count to finish
- Capture opponents on non-safe cells (sent home)
- Safe cells: start squares + star cells
- Extra turn on **6** or capture
- Three consecutive 6s skips the turn
- First player to finish all four tokens wins
