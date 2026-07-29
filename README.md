# SPREAD — backend

Passive market-making engine for Boursa Kuwait. Standalone Node.js service:
Express + Socket.IO + PostgreSQL.

**Post a limit buy at the bid, sell at the offer, never cross the spread.**
Profit is the spread minus commission. Direction is irrelevant.

---

## Run with Docker

```bash
cp .env.example .env          # fill in DB credentials
docker compose up --build -d
docker compose logs -f
```

Backend on **:4000**. Health at `http://localhost:4000/health`.

Development with hot reload:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Without Docker:

```bash
npm install
npm run dev                   # nodemon
```

---

## Verify before you trust it

```bash
npm run verify
```

Three scripts:

| Script | Checks |
|--------|--------|
| `VERIFY_screener.js` | Screens the real 28-Jul book at 500 and 2,500 KD |
| `VERIFY_service.js` | Snapshot throttling, alerts, session helpers |
| `VERIFY_e2e.js` | Record 5 legs, read back, P&L, snapshots — **must print NET 3.976 KD** |

`VERIFY_e2e.js` uses an in-memory DB stand-in, so it runs with no Postgres.

---

## Seed the first live session

```bash
npm run seed:dry
npm run seed
```

28 July 2026, 500 KD on AQAR. **Real money, not paper.**

| | Buy | Sell | Net |
|---|-----|------|-----|
| C1 | 111 x 4,500 - 09:11 | 112 - 09:30 | **+1.995** |
| C2 | 112 x 4,500 - 10:07 | 113 - 11:03 | **+1.981** |
| C3 | 111 x 5,000 - 09:59 | never filled | — |
| | | **Day** | **+3.976 KD** |

C3 is seeded deliberately. It sat behind a queue of 836,945 that grew to
1,011,045 while price walked 111 to 113. Drop it and the fill rate reads 2 of 2
instead of 2 of 3 — the number this strategy is actually being judged on.

---

## Structure

```
src/
  index.js              server — express + socket.io
  db.js                 postgres pool
  socket.js             spread:* events + 15s ticker
  lib/
    spread.config.js    budget, screen thresholds, snapshots, alerts, AI
    live.config.js      session times + commission schedule
    screener.js         economics and verdict. NO forecasting in it.
    commission.js       single source of truth for trade cost
    budget.js           slot floor and per-stock clearance
  services/
    repository.js       3 tables + P&L queries
    service.js          tick loop, snapshots, alerts, detail
    ai.js               Claude commentary and Q&A
  scripts/
    seed_28jul_live.js  the first live session
```

Reads `stock_quotes` — written by a **separate ingestion scraper**, not this
project. Owns three tables of its own, created automatically on first use.

---

## API

```
GET  /health              db + session state
GET  /api/screen?date=    the ranked list
GET  /api/stock/:symbol   book, suggested order, contracts
GET  /api/pnl?from=&to=   daily, by symbol, execution stats
```

Socket:

```
client -> spread:subscribe | budget | inspect | detail | leg | resolve
          edit | history | snapshot | pnl | ask
server -> spread:update | detail | comment | pnl | history | error
```

**Display is always live. Storage is throttled.** Every tick reaches the socket
so the screen never lags. A row is written to `spread_snapshots` only when the
qualifying set, the ranking, or a band moved — a queue drifting 68,300 to 68,325
is worth seeing and not worth storing. ~50-150 rows/day instead of ~3,600.

---

## Two rules that must not be softened

**1. Only `session = 'Trading'` quotes are executable.**

During Close Auction Acceptance (13:00-13:09) orders rest until one clearing
price is struck. On 28 July, IFA showed **40,000 shares offered at 338 against a
367 market** — and volume sat frozen for ten minutes before 100,000 shares traded
at 367 in a single instant. That seller received 367, not 338.

Screening auction quotes invents opportunities that cannot be traded.

**2. Never dump unlifted inventory.**

Measured over 7 days: dumping at the bid on a 45-minute timer gave **-5,270 KD**;
waiting for the lift gave **+3,014 KD**. Same trades, same fills.

---

## Queue position decides everything

Live evidence, same stock, same price, 28 July:

| Queue ahead | Outcome |
|-------------|---------|
| 0 (posted inside the spread) | filled in under 5 min |
| 41,241 | filled in 10 min |
| **836,945** | **never filled** |

The book is copied onto every order row because `stock_quotes` rolls after 11
days — without it that finding is unreconstructable a fortnight later.

---

## Commission

`lib/commission.js` is the single source of truth. Nothing may hardcode a rate.

| | Now | From 01-Oct-2026 |
|---|-----|------------------|
| Premier Market | 10 bps | 15 bps |
| **Main Market** | **15 bps** | 15 bps (unchanged) |
| Minimum per side | 0.250 KD | 0.500 KD (<= 333.33 KD) |
| **Settlement fee** | **0.500 KD/order > 50 KD** | **abolished** |

Verified against a real broker confirmation: 499.5 order value -> **1.249 KD**,
matching to three decimals. That is what established the settlement fee is
charged **per side**.

---

## AI commentary

Optional. No `ANTHROPIC_API_KEY` means no commentary and everything else works.

Two hard rules:

1. **The order price never comes from the model.** It comes from `screener.js` /
   `budget.js`. A hallucinated price is a real trade.
2. **It does not forecast direction.** ~130 honest day-runs across momentum, mean
   reversion, position-in-range and fib confirmation produced zero positive
   results. The prompt forbids it.

**No free SQL** — the backend runs fixed queries and hands over results.
Rate-limited to one call per symbol per 45 seconds.

---

## Fixes — 29 Jul 2026

### The one that mattered: buy and sell were not saving

Not a database failure. A silent early return two layers above it.

`svc.detail()` -> `inspectSymbol()` -> `oneSymbol()` filtered on
`session = 'Trading'` **and** the exact trading day. With no Trading-session
quote for that symbol on that date — after 13:00, on a past date, or on a symbol
that only ever printed in the auction — it returned `null`, so `economics` came
back `null`. In `SpreadDetail.jsx` the pre-fill effect opened with
`if (!e) return;`, price and shares stayed empty strings, and `save()` bailed on
`if (!price || !shares) return;`.

Nothing was emitted. No error, no console line. The button looked like it worked.

`oneSymbol` now falls back: latest Trading quote -> latest quote of any session
that day -> last known book, each flagged so the screen says which one it is
looking at. Screening keeps the hard Trading filter, because screening an
auction quote invents an opportunity that cannot be traded. Recording no longer
dies with it.

### Everything else that was wrong

| Area | Was | Now |
|---|---|---|
| Write feedback | none at all | `spread:saved` receipt on every write, plus the socket.io ack |
| Errors | cleared by the next 15s tick | sticky until dismissed or the next action |
| `spread:leg` | insert and refresh in one `try` | separate — a refresh failure is not reported as a save failure |
| Commission | client sent `roundTripKd / 2` from the **suggested** order | computed on the server from the actual price x shares, only on FILLED |
| Validation | none; Postgres type errors surfaced raw | `validateLeg()` rejects with a readable message |
| `spread:inspect` | economics only, no contracts | same shape as `spread:detail` |
| POSTED -> FILLED | no path anywhere in the UI | resolve controls per leg; fill rate can finally be measured |
| Fill/resolve times | one field, so `resolved_at = posted_at` | separate fields; `median_fill_min` is no longer always 0 |
| `postedAt` | built from `new Date()` | built from the selected trading day |
| Editing | any row click wrote `entry_mode='EDIT'` silently | explicit modal; camelCase and snake_case both accepted |
| 12:50 alert | only a resting SELL leg | all unlifted inventory, including a filled buy with no sell |
| Replay | emitted as `spread:update`, blanking the screen | its own `spread:snapshot` event |
| Ticker | only today's room | every room with listeners |
| `nextSeq` | `contracts.length + 1` | `max(seq) + 1` from the DB |
| Symbol case | never normalised on write | uppercased on write and on read |
| Dashboard | nothing ever called `loadPnl` | loads on mount |
| Budget box | seeded from `slotKd`, never resynced | seeded from the budget in force, resyncs unless being edited |
| `queueSharePct` | `Infinity` leaked into JSON as `null` | normalised in one place |

### New

- **`spread_events`** — append-only, timestamped action log. `spread_orders` is
  overwritten by resolve and edit, so it cannot answer "what did I do, in what
  order, and when". Backend only, never rendered. `GET /api/log?date=`.
- **`GET /api/diag`** — proves each link in the write path: connect, tables
  exist, read each table, insert-and-rollback, and whether quotes exist for
  today. "It is not saving" has four very different causes and guessing between
  them costs a session.
- **Day summary strip** on the list: deployed, free, gross, commission, net,
  trips, open positions.

### Verify

```bash
npm run verify
```

`TEST_socket_e2e.js` is new and is the one that matters: it drives the **real
socket handlers**, including the empty-book case the bug happened in. The
existing `VERIFY_e2e.js` calls the repository directly and recomputes P&L in
JavaScript, so the socket layer — where every reported failure actually lived —
had no coverage at all.

`VERIFY_service.js` now asserts instead of only printing. It was passing while
the close-holding alert silently produced nothing.

**Frontend: 41 checks. Backend: 37 socket checks plus the three original suites.**

---

## CR-2026-07-29 — implemented

Build order followed the CR: **CR-14 → CR-12 → CR-15 → CR-13.**

### CR-14 · carry-over and auction exit (the blocker)

The contract key is now `COALESCE(carried_from_day, trading_day)`, not
`trading_day`. A buy on the 29th and its sell on the 30th are one contract;
pairing on `trading_day` made that contract vanish from both days' P&L.

- New statuses `CARRIED` and `AUCTION_SUBMITTED`; new columns `carried_from_day`,
  `exit_venue`, `auction_price`, `carry_reason`, `peak_bid`.
- `spread:auction { id, price }` — submit with no price, come back and record the
  clearing price. Recording it writes the closing SELL leg keyed to the buy.
- `spread:carry { id, reason }` — deliberate overnight hold.
- Carried positions load on the first tick of the next day and are **pinned above
  today's contracts**, not filed as history.
- `budget.validate()` subtracts committed notional and says *"833 KD is held in an
  open position"* rather than *"budget too small"*. Different problems, different
  actions.
- **Keep the P&L, quarantine the statistics.** `executionStats` excludes carried
  legs entirely; the report separates realised from unrealised.
- P&L attributes to the **exit** day.

### CR-12 · trend filter

`trendMap()` reads `stock_prices_daily`; RISING / FLAT / FALLING over 3 sessions.
Falling stocks are **demoted with the reason on the row**, not hidden — the rule
teaches nothing if you cannot see it fire. Ranking is `netKd × expectedFilsByTrend`,
so a rising +7.00 (6.38) now outranks a falling +8.22 (5.88). `trend_at_entry` is
stored on every leg, without which the rule can never be validated on real fills.

### CR-15 · trailing exit

`lib/exit.js`. Arm at +1, trail by 1, **the trail only moves up**, fires on the
**first downtick**, steps down to the floor after 45 minutes. The peak is
persisted on the buy row via `GREATEST`, so it cannot walk backwards. The detail
page shows entry, peak seen, trailing offer and arm level.

### CR-13 · gap-priority entry

`entryPlacement` is `INSIDE` (spread ≥ 2 → post at `bid+1`, queue **zero**) or
`QUEUED` (spread 1 → `bid`). Gross is now what **you** capture from where you
actually post — posting inside gives up a fil and the number says so. EMIRATES
reads +1.11 at 500 KD, not +8.22.

A 1-fil spread produces a **WAIT** row: *"no gap — wait for 235/237"*. The
150-trades/day floor is enforced, so KAMCO fails at 86 trades despite a 67.9% gap.
`gapPct` is a tiebreaker only, never a rank.

### Three things worth your attention

**1. `entry_mode` collision.** CR-13 asks for `entry_mode` to hold `INSIDE/QUEUED`,
but that column already holds `BUTTON/MANUAL/EDIT` and is already being written.
Overloading it destroys live data. Placement went to **`entry_placement`**.

**2. CR-15 can arm below break-even.** `armAtFils: 1` with `hardTargetFils: null`
means trailing out at +1 fil — and the CR's own CR-13 section shows a 1-fil
capture at that size netting roughly nothing. `EXIT.respectCostFloor` (default
**true**) raises the arm level to the greater of +1 and the fils needed to clear
the round trip. Set it false to follow the CR literally.

**3. The −0.06 KD figure does not reproduce.** Priced through `commission.js` at
800 KD on a 235-fil stock with a 1-fil capture, the model gives **+0.003 KD** —
break-even, not a small loss. Same conclusion (nowhere near the 1.0 KD floor), but
worth reconciling against the real broker slip before the number is quoted again.

### Verify

```bash
npm run verify
```

Five suites. `TEST_cr_2026_07_29.js` checks every CR rule against the numbers in
the document; `TEST_socket_e2e.js` drives carry → next-day sell → auction close
through the real handlers.

**Backend 58 + 34 checks. Frontend 54 checks.**

### Still open

The CR asks whether a carried position stays a SPREAD trade. Implemented as
recommended — `CARRIED`, P&L kept, statistics quarantined. Say if you want it
split into its own strategy row instead.

**Total real fills to date: 4.** Every threshold here should be re-measured once
`spread_orders` holds 50+.
