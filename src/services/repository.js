'use strict';
/*
 * ============================================================================
 *  spread.repository.js — persistence for the SPREAD strategy
 * ============================================================================
 * Three tables. Every one carries a `strategy` column from day one so the
 * cross-strategy dashboard can group without a migration later — cheap now,
 * painful to retrofit.
 *
 *   spread_orders     one row per LEG. A contract is two legs sharing a seq.
 *   spread_snapshots  what the screen showed, written only on material change.
 *   spread_config     budget and thresholds, append-only and versioned.
 *
 * WHY LEGS AND NOT CONTRACTS
 * --------------------------
 * A buy that never fills is still a result — arguably the most useful one. On
 * 28-Jul, C3 was posted at 111 behind a queue of 836,945, never filled, and
 * explained the whole session better than either winning trade. A contract-shaped
 * table would have had nowhere to put it.
 *
 * WHY THE BOOK IS COPIED ONTO EVERY LEG
 * -------------------------------------
 * queue_ahead_qty is the field that predicted everything on day one:
 *     queue 0        -> filled under 5 minutes
 *     queue 41,241   -> filled in 10 minutes
 *     queue 836,945  -> never filled
 * stock_quotes rolls after 11 days. If the book is not copied onto the order at
 * the moment it was posted, that finding is unreconstructable a fortnight later.
 * ============================================================================
 */
const { pool } = require('../db');

const DDL = `
CREATE TABLE IF NOT EXISTS public.spread_orders (
  id            bigserial PRIMARY KEY,
  strategy      text NOT NULL DEFAULT 'SPREAD',
  trading_day   date NOT NULL,
  symbol        text NOT NULL,
  seq           int  NOT NULL,              -- C1, C2, C3 per symbol per day
  side          text NOT NULL,              -- BUY | SELL
  status        text NOT NULL,              -- POSTED | FILLED | CANCELLED | EXPIRED
  price         numeric NOT NULL,           -- what YOU posted, not what we suggested
  shares        bigint  NOT NULL,
  suggested_price numeric,                  -- what the screen said, for drift analysis
  suggested_shares bigint,
  posted_at     timestamptz NOT NULL,
  resolved_at   timestamptz,                -- filled, cancelled or expired
  -- book AT THE MOMENT OF POSTING (stock_quotes rolls; this must not)
  book_bid      numeric, book_bid_qty  bigint,
  book_offer    numeric, book_offer_qty bigint,
  queue_ahead_qty bigint,
  queue_share_pct numeric,
  spread_fils   numeric,
  market        text,
  commission_kd numeric,
  notional_kd   numeric,
  entry_mode    text,                       -- BUTTON | MANUAL | EDIT
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spread_orders_day_idx    ON public.spread_orders (trading_day, symbol, seq);
CREATE INDEX IF NOT EXISTS spread_orders_open_idx   ON public.spread_orders (status) WHERE status = 'POSTED';

/*
 * CR-12, CR-13, CR-14 columns. Added, never re-created — these tables hold real
 * money and the DDL runs on every boot.
 *
 * NAMING COLLISION, DELIBERATELY AVOIDED. CR-13 asks for entry_mode to hold
 * INSIDE/QUEUED, but entry_mode already exists and holds BUTTON/MANUAL/EDIT --
 * how the row was typed in, which is a different question and is already being
 * written. Overloading it would silently destroy the existing values, so
 * placement lives in entry_placement.
 *
 * carried_from_day is the CONTRACT KEY, not a flag. A buy on the 29th and its
 * sell on the 30th belong to one contract; pairing on trading_day made that
 * contract vanish from both days' P&L.
 */
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS trend_at_entry    text;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS entry_placement   text;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS gap_fils_at_entry int;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS carried_from_day  date;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS exit_venue        text;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS auction_price     numeric;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS carry_reason      text;
ALTER TABLE public.spread_orders ADD COLUMN IF NOT EXISTS peak_bid          numeric;
CREATE INDEX IF NOT EXISTS spread_orders_carry_idx ON public.spread_orders (carried_from_day, symbol, seq);

CREATE TABLE IF NOT EXISTS public.spread_snapshots (
  id           bigserial PRIMARY KEY,
  strategy     text NOT NULL DEFAULT 'SPREAD',
  trading_day  date NOT NULL,
  taken_at     timestamptz NOT NULL,
  budget_kd    numeric NOT NULL,            -- the budget IN FORCE, so replay is honest
  max_stocks   int NOT NULL,
  slot_kd      numeric,
  ceiling_fils int,
  scanned      int,
  reason       text,                        -- why this row was written
  rows         jsonb NOT NULL               -- [{symbol,bid,offer,spread,shares,queue_share_pct,net_kd,rank,demoted}]
);
CREATE INDEX IF NOT EXISTS spread_snapshots_day_idx ON public.spread_snapshots (trading_day, taken_at DESC);

CREATE TABLE IF NOT EXISTS public.spread_config (
  id          bigserial PRIMARY KEY,
  strategy    text NOT NULL DEFAULT 'SPREAD',
  version     int  NOT NULL,
  payload     jsonb NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

/*
 * Timestamped action log. Append-only, backend only, never rendered.
 *
 * spread_orders holds the CURRENT state of a leg — resolve and edit overwrite
 * in place, so the row cannot answer "what did I do, in what order, and when".
 * Reconstructing a session after the fact is the whole point of keeping this
 * data, and an UPDATE destroys exactly the evidence needed. Every mutation
 * writes a row here as well.
 */
CREATE TABLE IF NOT EXISTS public.spread_events (
  id          bigserial PRIMARY KEY,
  strategy    text NOT NULL DEFAULT 'SPREAD',
  trading_day date NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  symbol      text,
  order_id    bigint,
  action      text NOT NULL,        -- RECORD | RESOLVE | EDIT | DELETE | BUDGET
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS spread_events_day_idx ON public.spread_events (trading_day, at);
`;

let ensured = false;
async function ensure(db = pool) {
  if (ensured) return;
  await db.query(DDL);
  ensured = true;
}

/* ---------------------------------------------------------------- orders -- */

/** Next contract number for a symbol today. C1, C2, C3... */
async function nextSeq(tradingDay, symbol, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT COALESCE(max(seq), 0) + 1 AS n FROM public.spread_orders
      WHERE trading_day = $1 AND upper(symbol) = $2;`,
    [tradingDay, String(symbol || '').trim().toUpperCase()]);
  return Number(rows[0].n);
}

/**
 * Record a leg. Called when YOU say something happened — never inferred.
 * `suggested_*` is stored alongside `price`/`shares` so drift between what the
 * screen advised and what was actually placed is measurable. On 28-Jul the
 * screen said 4,500 and 5,000 was placed; a table that only kept one number
 * would have shown the wrong P&L all day.
 */
const SIDES = new Set(['BUY', 'SELL']);
// CARRIED and AUCTION_SUBMITTED are CR-14. A filled buy with no matching sell
// used to be indistinguishable from "waiting for a lift today" — there was no
// way to say "held overnight, deliberately".
const STATUSES = new Set(['POSTED', 'FILLED', 'CANCELLED', 'EXPIRED',
                          'CARRIED', 'AUCTION_SUBMITTED']);

/**
 * Reject a bad leg loudly instead of letting Postgres throw a type error that
 * surfaces to the user as "invalid input syntax for type numeric". A silent or
 * cryptic failure on the one write that matters is the worst outcome here.
 */
function validateLeg(o) {
  const bad = [];
  const sym = String(o.symbol || '').trim().toUpperCase();
  if (!sym) bad.push('symbol is required');
  const side = String(o.side || '').trim().toUpperCase();
  if (!SIDES.has(side)) bad.push(`side must be BUY or SELL, got "${o.side}"`);
  const status = String(o.status || 'POSTED').trim().toUpperCase();
  if (!STATUSES.has(status)) bad.push(`status must be one of ${[...STATUSES].join('/')}, got "${o.status}"`);
  const price = Number(o.price);
  if (!Number.isFinite(price) || price <= 0) bad.push(`price must be a positive number, got "${o.price}"`);
  const shares = Number(o.shares);
  if (!Number.isFinite(shares) || shares <= 0) bad.push(`shares must be a positive number, got "${o.shares}"`);
  if (!o.tradingDay) bad.push('tradingDay is required');
  if (bad.length) { const e = new Error(bad.join('; ')); e.code = 'BAD_LEG'; throw e; }
  return { ...o, symbol: sym, side, status, price, shares, seq: Number(o.seq) };
}

/** Append-only. Never throws into the caller — a failed log must not lose a fill. */
async function logEvent(ev, db = pool) {
  try {
    await ensure(db);
    await db.query(
      `INSERT INTO public.spread_events (trading_day, symbol, order_id, action, detail)
       VALUES ($1,$2,$3,$4,$5);`,
      [ev.tradingDay, ev.symbol ?? null, ev.orderId ?? null, ev.action,
       JSON.stringify(ev.detail ?? {})]);
  } catch (e) { console.warn('[spread] event log:', e.message); }
}

async function recordLeg(input, db = pool) {
  await ensure(db);
  const o = validateLeg(input);
  const { rows } = await db.query(
    `INSERT INTO public.spread_orders
       (trading_day,symbol,seq,side,status,price,shares,suggested_price,suggested_shares,
        posted_at,resolved_at,book_bid,book_bid_qty,book_offer,book_offer_qty,
        queue_ahead_qty,queue_share_pct,spread_fils,market,commission_kd,notional_kd,entry_mode,note,
        trend_at_entry,entry_placement,gap_fils_at_entry,carried_from_day,exit_venue,peak_bid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
             $24,$25,$26,$27,$28,$29)
     RETURNING *;`,
    [o.tradingDay, o.symbol, o.seq, o.side, o.status || 'POSTED', o.price, o.shares,
     o.suggestedPrice ?? null, o.suggestedShares ?? null,
     o.postedAt || new Date(), o.resolvedAt ?? null,
     o.bookBid ?? null, o.bookBidQty ?? null, o.bookOffer ?? null, o.bookOfferQty ?? null,
     o.queueAheadQty ?? null, o.queueSharePct ?? null, o.spreadFils ?? null,
     o.market ?? null, o.commissionKd ?? null, o.notionalKd ?? null,
     o.entryMode || 'MANUAL', o.note ?? null,
     // Without trend_at_entry the CR-12 rule can never be validated against
     // real fills — the whole point of shipping it now.
     o.trendAtEntry ?? null, o.entryPlacement ?? null, o.gapFilsAtEntry ?? null,
     o.carriedFromDay ?? null, o.exitVenue ?? null, o.peakBid ?? null]);
  await logEvent({ tradingDay: o.tradingDay, symbol: o.symbol, orderId: rows[0].id,
                   action: 'RECORD', detail: rows[0] }, db);
  return rows[0];
}

/** Resolve a posted leg — filled, cancelled or expired. */
async function resolveLeg(id, status, resolvedAt, patch = {}, db = pool) {
  await ensure(db);
  if (!id) { const e = new Error('resolve needs an order id'); e.code = 'BAD_LEG'; throw e; }
  const st = String(status || '').trim().toUpperCase();
  if (!STATUSES.has(st)) {
    const e = new Error(`status must be one of ${[...STATUSES].join('/')}, got "${status}"`);
    e.code = 'BAD_LEG'; throw e;
  }
  status = st;
  const { rows } = await db.query(
    `UPDATE public.spread_orders
        SET status=$2, resolved_at=$3,
            price=COALESCE($4, price), shares=COALESCE($5, shares),
            commission_kd=COALESCE($6, commission_kd), note=COALESCE($7, note),
            updated_at=now()
      WHERE id=$1 RETURNING *;`,
    [id, status, resolvedAt || new Date(), patch.price ?? null, patch.shares ?? null,
     patch.commissionKd ?? null, patch.note ?? null]);
  if (!rows[0]) { const e = new Error(`no order with id ${id}`); e.code = 'BAD_LEG'; throw e; }
  await logEvent({ tradingDay: rows[0].trading_day, symbol: rows[0].symbol, orderId: id,
                   action: 'RESOLVE', detail: { status, patch } }, db);
  return rows[0];
}

/**
 * Edit a leg.
 *
 * The frontend used to hand this the raw DB row, whose keys are snake_case,
 * while this function only ever read camelCase — so posted_at, resolved_at and
 * commission_kd silently became null, COALESCE kept the old values, and the
 * only visible effect was entry_mode flipping to 'EDIT' on a row nobody meant
 * to touch. Both spellings are accepted now, and an empty patch is a no-op
 * rather than a write.
 */
async function updateLeg(id, patch = {}, db = pool) {
  await ensure(db);
  if (!id) { const e = new Error('edit needs an order id'); e.code = 'BAD_LEG'; throw e; }
  const pick = (a, b) => (patch[a] !== undefined && patch[a] !== null ? patch[a]
                        : (patch[b] !== undefined && patch[b] !== null ? patch[b] : null));
  const price = pick('price', 'price');
  const shares = pick('shares', 'shares');
  const side = pick('side', 'side');
  const status = pick('status', 'status');
  const postedAt = pick('postedAt', 'posted_at');
  const resolvedAt = pick('resolvedAt', 'resolved_at');
  const commissionKd = pick('commissionKd', 'commission_kd');
  const note = pick('note', 'note');

  const fields = [price, shares, side, status, postedAt, resolvedAt, commissionKd, note];
  if (fields.every((v) => v === null)) {
    const { rows } = await db.query('SELECT * FROM public.spread_orders WHERE id=$1;', [id]);
    return rows[0] || null;                     // nothing to change — do not write
  }
  if (side != null && !SIDES.has(String(side).toUpperCase())) {
    const e = new Error(`side must be BUY or SELL, got "${side}"`); e.code = 'BAD_LEG'; throw e;
  }
  if (status != null && !STATUSES.has(String(status).toUpperCase())) {
    const e = new Error(`bad status "${status}"`); e.code = 'BAD_LEG'; throw e;
  }

  const { rows } = await db.query(
    `UPDATE public.spread_orders
        SET price=COALESCE($2,price), shares=COALESCE($3,shares), side=COALESCE($4,side),
            status=COALESCE($5,status), posted_at=COALESCE($6,posted_at),
            resolved_at=COALESCE($7,resolved_at), commission_kd=COALESCE($8,commission_kd),
            note=COALESCE($9,note), entry_mode='EDIT', updated_at=now()
      WHERE id=$1 RETURNING *;`,
    [id, price, shares, side ? String(side).toUpperCase() : null,
     status ? String(status).toUpperCase() : null,
     postedAt, resolvedAt, commissionKd, note]);
  if (!rows[0]) { const e = new Error(`no order with id ${id}`); e.code = 'BAD_LEG'; throw e; }
  await logEvent({ tradingDay: rows[0].trading_day, symbol: rows[0].symbol, orderId: id,
                   action: 'EDIT', detail: patch }, db);
  return rows[0];
}

async function legById(id, db = pool) {
  await ensure(db);
  const { rows } = await db.query('SELECT * FROM public.spread_orders WHERE id=$1;', [id]);
  return rows[0] || null;
}

/** Remove a mistyped leg. The event log keeps the fact that it existed. */
async function deleteLeg(id, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    'DELETE FROM public.spread_orders WHERE id=$1 RETURNING *;', [id]);
  if (!rows[0]) { const e = new Error(`no order with id ${id}`); e.code = 'BAD_LEG'; throw e; }
  await logEvent({ tradingDay: rows[0].trading_day, symbol: rows[0].symbol, orderId: id,
                   action: 'DELETE', detail: rows[0] }, db);
  return rows[0];
}

async function legsForDay(tradingDay, symbol = null, db = pool) {
  await ensure(db);
  // Uppercase on read as well as on write. Rows recorded before the write-side
  // normalisation went in can be lowercase, and a case mismatch makes a saved
  // contract invisible on the detail page — which reads as "it did not save".
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;
  const { rows } = await db.query(
    `SELECT * FROM public.spread_orders
      WHERE trading_day = $1 AND ($2::text IS NULL OR upper(symbol) = $2)
      ORDER BY symbol, seq, posted_at;`, [tradingDay, sym]);
  return rows;
}

/*
 * CR-14. Positions open as of a day, opened on ANY day.
 *
 * The contract key is (symbol, seq, COALESCE(carried_from_day, trading_day)).
 * A buy on the 29th and its sell on the 30th are ONE contract; pairing on
 * trading_day alone made that contract vanish from both days.
 *
 * "Open" means a filled or carried buy with no filled sell against the same key.
 * A submitted auction order is still open until the fill price is recorded.
 */
async function openPositions(asOfDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `WITH k AS (
       SELECT *, COALESCE(carried_from_day, trading_day) AS ckey
         FROM public.spread_orders
        WHERE COALESCE(carried_from_day, trading_day) <= $1
     ), buys AS (
       SELECT * FROM k WHERE side='BUY' AND status IN ('FILLED','CARRIED')
     ), sold AS (
       SELECT symbol, seq, ckey FROM k
        WHERE side='SELL' AND status IN ('FILLED')
     )
     SELECT b.* FROM buys b
      WHERE NOT EXISTS (
        SELECT 1 FROM sold s
         WHERE s.symbol=b.symbol AND s.seq=b.seq AND s.ckey=b.ckey)
      ORDER BY b.ckey, b.symbol, b.seq;`, [asOfDay]);
  return rows;
}

/** Mark a buy as deliberately held overnight, or submitted to the auction. */
async function setCarryState(id, { status, exitVenue, carryReason, auctionPrice, peakBid }, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `UPDATE public.spread_orders
        SET status           = COALESCE($2, status),
            exit_venue       = COALESCE($3, exit_venue),
            carry_reason     = COALESCE($4, carry_reason),
            auction_price    = COALESCE($5, auction_price),
            peak_bid         = COALESCE($6, peak_bid),
            -- Stamp the contract key the first time it is carried, so tomorrow
            -- the sell can be attached to today's buy.
            carried_from_day = COALESCE(carried_from_day, trading_day),
            updated_at       = now()
      WHERE id=$1 RETURNING *;`,
    [id, status ?? null, exitVenue ?? null, carryReason ?? null,
     auctionPrice ?? null, peakBid ?? null]);
  if (!rows[0]) { const e = new Error(`no order with id ${id}`); e.code = 'BAD_LEG'; throw e; }
  await logEvent({ tradingDay: rows[0].trading_day, symbol: rows[0].symbol, orderId: id,
                   action: status === 'CARRIED' ? 'CARRY' : 'AUCTION',
                   detail: { status, exitVenue, carryReason, auctionPrice } }, db);
  return rows[0];
}

/** Running peak bid since the fill. Monotonic — the trail never moves down. */
async function bumpPeak(id, bid, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `UPDATE public.spread_orders SET peak_bid = GREATEST(COALESCE(peak_bid, 0), $2), updated_at = now()
      WHERE id = $1 AND (peak_bid IS NULL OR peak_bid < $2) RETURNING *;`, [id, bid]);
  return rows[0] || null;
}

/*
 * CR-12. Direction over the last N sessions from stock_prices_daily.
 * RISING  close > prev AND close >= close_Nd
 * FALLING close < prev AND close <  close_Nd
 * else FLAT
 */
/*
 * Resolve the date and close columns on stock_prices_daily.
 *
 * I hard-coded `trade_date` and `close` from memory and got "column close does
 * not exist". Rather than guess again, ask the catalogue once and cache it — and
 * if nothing matches, fail with the ACTUAL column list so the next person does
 * not have to guess either.
 */
let dailyCols = null;
const DATE_CANDIDATES  = ['trade_date', 'price_date', 'quote_date', 'bar_date', 'date', 'day', 'dt', 'as_of'];
const CLOSE_CANDIDATES = ['close', 'close_price', 'closing_price', 'price_close', 'last_price',
                          'last', 'settle_price', 'adj_close', 'c'];

async function resolveDailyCols(db = pool) {
  if (dailyCols) return dailyCols;
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stock_prices_daily';`);
  if (!rows.length) {
    const e = new Error('public.stock_prices_daily does not exist or is not visible to this user');
    e.code = 'NO_DAILY'; throw e;
  }
  const have = new Set(rows.map((r) => r.column_name));
  const pick = (list) => list.find((c) => have.has(c)) || null;
  const dateCol = process.env.DAILY_DATE_COL || pick(DATE_CANDIDATES);
  const closeCol = process.env.DAILY_CLOSE_COL || pick(CLOSE_CANDIDATES);
  const symCol = have.has('symbol') ? 'symbol' : (have.has('ticker') ? 'ticker' : null);

  if (!dateCol || !closeCol || !symCol) {
    const e = new Error(
      'cannot map stock_prices_daily — ' +
      `date=${dateCol || 'NOT FOUND'}, close=${closeCol || 'NOT FOUND'}, symbol=${symCol || 'NOT FOUND'}. ` +
      `Columns present: ${[...have].join(', ')}. ` +
      'Set DAILY_DATE_COL / DAILY_CLOSE_COL in the environment to override.');
    e.code = 'NO_DAILY'; throw e;
  }
  dailyCols = { dateCol, closeCol, symCol };
  console.log(`[spread] stock_prices_daily mapped: symbol=${symCol}, date=${dateCol}, close=${closeCol}`);
  return dailyCols;
}

/*
 * CR-12. Direction over the last N sessions.
 * RISING  close > prev AND close >= close_Nd
 * FALLING close < prev AND close <  close_Nd
 * else FLAT
 *
 * 20+ sessions, not 3 — a four-day window reads the noise inside a downtrend as
 * calm. ARGAN looked flat across four sessions having fallen 139 -> 119 over five
 * weeks, including an 8-fil gap down on 14 July.
 */
async function trendMap(asOfDay, lookbackDays = 20, db = pool) {
  const { dateCol, closeCol, symCol } = await resolveDailyCols(db);
  const { rows } = await db.query(
    `WITH d AS (
       SELECT ${symCol} AS symbol, ${closeCol}::numeric AS close,
              row_number() OVER (PARTITION BY ${symCol} ORDER BY ${dateCol} DESC) AS rn
         FROM public.stock_prices_daily
        WHERE ${dateCol} <= $1 AND ${closeCol} IS NOT NULL
     )
     SELECT symbol,
            max(close) FILTER (WHERE rn = 1)             AS c0,
            max(close) FILTER (WHERE rn = 2)             AS c1,
            max(close) FILTER (WHERE rn = $2::int + 1)   AS cn
       FROM d WHERE rn <= $2::int + 1 GROUP BY symbol;`, [asOfDay, lookbackDays]);

  const m = new Map();
  for (const r of rows) {
    const c0 = Number(r.c0), c1 = Number(r.c1), cn = Number(r.cn);
    if (!Number.isFinite(c0)) continue;
    const prev = Number.isFinite(c1) ? c1 : c0;
    const base = Number.isFinite(cn) ? cn : prev;
    let trend = 'FLAT';
    if (c0 > prev && c0 >= base) trend = 'RISING';
    else if (c0 < prev && c0 < base) trend = 'FALLING';
    m.set(r.symbol, { trend, changeFils: c0 - base, close: c0 });
  }
  return m;
}

/*
 * GATE 2 — postable queue, measured across ticks.
 *
 * Not "is the depth right-sized this instant" but "how often is it". Depth
 * swings enormously minute to minute, so the mean is misleading and a single
 * reading is close to noise. Your order wants to be 2-30% of the resting bid:
 * under 2% you sit behind a wall (836,945 ahead never filled), over 30% you
 * ARE the book. This is the gate that gets skipped, and skipping it is how
 * every bad recommendation happened.
 */
async function postableMap(asOfDay, slotKd, cfg, db = pool) {
  const lo = slotKd / (cfg.postableHighPct / 100);   // depth big enough that you are not the book
  const hi = slotKd / (cfg.postableLowPct / 100);    // depth small enough that you are not behind a wall
  const { rows } = await db.query(
    `SELECT symbol,
            round(100.0 * count(*) FILTER (
              WHERE bid_qty::numeric * bid::numeric / 1000 BETWEEN $2 AND $3
            ) / NULLIF(count(*),0)) AS pct_postable,
            count(*) AS ticks
       FROM public.stock_quotes
      WHERE session = 'Trading' AND bid > 0 AND offer > bid
        AND (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date
            BETWEEN ($1::date - interval '12 days') AND $1::date
      GROUP BY symbol;`, [asOfDay, lo, hi]);
  const m = new Map();
  for (const r of rows) m.set(r.symbol, { pct: Number(r.pct_postable), ticks: Number(r.ticks) });
  return m;
}

/*
 * CR-13. Share of recent sessions spent at a spread of 2 or more.
 * A TIEBREAKER between stocks that already passed the liquidity floor — never a
 * rank. A wide spread and a dead tape are the same fact.
 */
async function gapMap(asOfDay, sessions = 10, db = pool) {
  const { rows } = await db.query(
    `WITH days AS (
       SELECT DISTINCT (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date AS d
         FROM public.stock_quotes
        WHERE (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date <= $1
        ORDER BY d DESC LIMIT $2::int
     )
     SELECT symbol,
            round(100.0 * count(*) FILTER (WHERE offer - bid >= 2) / NULLIF(count(*),0), 1) AS gap_pct,
            round(avg(trades)) AS avg_trades
       FROM public.stock_quotes
      WHERE session = 'Trading' AND bid > 0 AND offer > bid
        AND (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date IN (SELECT d FROM days)
      GROUP BY symbol;`, [asOfDay, sessions]);
  const m = new Map();
  for (const r of rows) m.set(r.symbol, Number(r.gap_pct));
  return m;
}

/*
 * CR-14. Every leg belonging to a contract that touches this day, whichever day
 * each leg was recorded on.
 *
 * legsForDay() filters on trading_day, which is right until a contract spans a
 * day boundary: record the sell on the 30th for a buy made on the 29th and the
 * detail page sees a lone SELL, reads it as a fresh contract, and shows the
 * state as 'posted' with no net. The contract key is
 * COALESCE(carried_from_day, trading_day) — this collects both ends of it.
 */
async function legsForContractsTouching(tradingDay, symbol, db = pool) {
  await ensure(db);
  const sym = String(symbol || '').trim().toUpperCase();
  const { rows } = await db.query(
    `WITH k AS (
       SELECT DISTINCT COALESCE(carried_from_day, trading_day) AS ckey
         FROM public.spread_orders
        WHERE upper(symbol) = $2
          AND (trading_day = $1 OR COALESCE(carried_from_day, trading_day) = $1)
     )
     SELECT * FROM public.spread_orders
      WHERE upper(symbol) = $2
        AND (trading_day = $1
             OR COALESCE(carried_from_day, trading_day) IN (SELECT ckey FROM k))
      ORDER BY seq, posted_at;`, [tradingDay, sym]);
  return rows;
}

/** The timestamped action log for a day. Backend/analysis only. */
async function eventsForDay(tradingDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT * FROM public.spread_events WHERE trading_day = $1 ORDER BY at, id;`, [tradingDay]);
  return rows;
}

/** Anything posted and unresolved — drives the 12:50 alert. */
async function openLegs(tradingDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT * FROM public.spread_orders
      WHERE trading_day = $1 AND status = 'POSTED' ORDER BY posted_at;`, [tradingDay]);
  return rows;
}

/* ------------------------------------------------------------- snapshots -- */

async function writeSnapshot(s, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `INSERT INTO public.spread_snapshots
       (trading_day,taken_at,budget_kd,max_stocks,slot_kd,ceiling_fils,scanned,reason,rows)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, taken_at;`,
    [s.tradingDay, s.takenAt || new Date(), s.budgetKd, s.maxStocks, s.slotKd ?? null,
     s.ceilingFils ?? null, s.scanned ?? null, s.reason ?? null, JSON.stringify(s.rows || [])]);
  return rows[0];
}

/** Nearest snapshot at or before a moment — the history filter. */
async function snapshotAt(tradingDay, at, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT * FROM public.spread_snapshots
      WHERE trading_day = $1 AND taken_at <= $2
      ORDER BY taken_at DESC LIMIT 1;`, [tradingDay, at]);
  return rows[0] || null;
}

async function snapshotTimes(tradingDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT id, taken_at, reason, jsonb_array_length(rows) AS n
       FROM public.spread_snapshots WHERE trading_day = $1 ORDER BY taken_at;`, [tradingDay]);
  return rows;
}

/* ----------------------------------------------------------------- p&l --- */

/**
 * Daily P&L. Pairs legs by (symbol, seq); a contract needs both.
 * Unfilled buys are counted in `orders` but not in `trips` — they cost nothing
 * and earned nothing, but the fill rate is the number that matters most early on.
 */
async function pnlByDay(fromDay, toDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT id, trading_day, symbol, seq, side, status, price, shares,
              COALESCE(commission_kd,0) AS comm,
              COALESCE(carried_from_day, trading_day) AS ckey,
              carried_from_day IS NOT NULL AS carried
         FROM public.spread_orders
     ), c AS (
       SELECT symbol, seq, ckey,
              bool_or(carried)                                            AS carried,
              min(trading_day) FILTER (WHERE side='BUY')                  AS open_day,
              max(trading_day) FILTER (WHERE side='SELL' AND status='FILLED') AS exit_day,
              max(price)  FILTER (WHERE side='BUY'  AND status IN ('FILLED','CARRIED')) AS buy_px,
              max(price)  FILTER (WHERE side='SELL' AND status='FILLED')  AS sell_px,
              max(shares) FILTER (WHERE side='BUY'  AND status IN ('FILLED','CARRIED')) AS sh,
              sum(comm)   FILTER (WHERE status='FILLED')                  AS comm,
              count(*)                                                    AS legs,
              count(*)    FILTER (WHERE status='FILLED')                  AS filled
         FROM legs GROUP BY 1,2,3
     ), attributed AS (
       -- P&L belongs to the day the position was CLOSED. A contract opened on
       -- the 29th and sold on the 30th is a 30th result; pairing on trading_day
       -- made it disappear from both.
       SELECT COALESCE(exit_day, open_day) AS trading_day, *
         FROM c
     )
     SELECT trading_day,
            count(*) FILTER (WHERE buy_px IS NOT NULL AND sell_px IS NOT NULL) AS trips,
            sum(legs)   AS orders,
            sum(filled) AS fills,
            COALESCE(sum(((sell_px-buy_px)*sh)/1000)
                     FILTER (WHERE sell_px IS NOT NULL AND buy_px IS NOT NULL),0) AS gross_kd,
            COALESCE(sum(comm),0) AS commission_kd,
            COALESCE(sum(((sell_px-buy_px)*sh)/1000)
                     FILTER (WHERE sell_px IS NOT NULL AND buy_px IS NOT NULL),0)
              - COALESCE(sum(comm),0) AS net_kd,
            -- CR-14. Carried trips are a directional bet, not a spread capture.
            -- Keep the P&L, quarantine the statistics: these are reported
            -- separately so they cannot distort fill rate or expected fils.
            count(*) FILTER (WHERE carried AND sell_px IS NOT NULL)            AS carried_trips,
            COALESCE(sum(((sell_px-buy_px)*sh)/1000 - COALESCE(comm,0))
                     FILTER (WHERE carried AND sell_px IS NOT NULL),0)         AS carried_net_kd,
            count(*) FILTER (WHERE sell_px IS NULL AND buy_px IS NOT NULL)     AS still_open,
            COALESCE(sum((buy_px*sh)/1000)
                     FILTER (WHERE sell_px IS NULL AND buy_px IS NOT NULL),0)  AS open_cost_kd
       FROM attributed
      WHERE trading_day BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 1;`, [fromDay, toDay]);
  return rows;
}

/**
 * Unrealised P&L on everything still open, marked against the latest bid.
 * Separate from realised on purpose — a carried position is not a result yet.
 */
async function unrealised(asOfDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `WITH open AS (
       SELECT o.symbol, o.seq, o.price AS buy_px, o.shares,
              COALESCE(o.carried_from_day, o.trading_day) AS ckey
         FROM public.spread_orders o
        WHERE o.side='BUY' AND o.status IN ('FILLED','CARRIED')
          AND COALESCE(o.carried_from_day, o.trading_day) <= $1
          AND NOT EXISTS (
            SELECT 1 FROM public.spread_orders s
             WHERE s.side='SELL' AND s.status='FILLED' AND s.symbol=o.symbol
               AND s.seq=o.seq
               AND COALESCE(s.carried_from_day, s.trading_day)
                   = COALESCE(o.carried_from_day, o.trading_day))
     ), mark AS (
       SELECT DISTINCT ON (symbol) symbol, bid
         FROM public.stock_quotes
        WHERE bid > 0 ORDER BY symbol, created_at DESC
     )
     SELECT o.symbol, o.seq, o.ckey AS opened, o.buy_px, o.shares, m.bid,
            ((COALESCE(m.bid, o.buy_px) - o.buy_px) * o.shares)/1000 AS unrealised_kd,
            (o.buy_px * o.shares)/1000 AS committed_kd
       FROM open o LEFT JOIN mark m ON m.symbol = o.symbol
      ORDER BY o.ckey, o.symbol;`, [asOfDay]);
  return rows;
}

async function pnlBySymbol(fromDay, toDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `WITH c AS (
       SELECT symbol, seq,
              COALESCE(carried_from_day, trading_day) AS ckey,
              bool_or(carried_from_day IS NOT NULL)   AS carried,
              max(trading_day) FILTER (WHERE side='SELL' AND status='FILLED') AS exit_day,
              min(trading_day) FILTER (WHERE side='BUY')                      AS open_day,
              max(price)  FILTER (WHERE side='BUY'  AND status IN ('FILLED','CARRIED')) AS buy_px,
              max(price)  FILTER (WHERE side='SELL' AND status='FILLED')      AS sell_px,
              max(shares) FILTER (WHERE side='BUY'  AND status IN ('FILLED','CARRIED')) AS sh,
              sum(COALESCE(commission_kd,0)) FILTER (WHERE status='FILLED')   AS comm
         FROM public.spread_orders
        GROUP BY 1,2,3)
     SELECT symbol,
            count(*) FILTER (WHERE sell_px IS NOT NULL) AS trips,
            count(*) FILTER (WHERE carried AND sell_px IS NOT NULL) AS carried_trips,
            COALESCE(sum(((sell_px-buy_px)*sh)/1000 - COALESCE(comm,0))
                     FILTER (WHERE sell_px IS NOT NULL),0) AS net_kd
       FROM c
      WHERE COALESCE(exit_day, open_day) BETWEEN $1 AND $2
      GROUP BY 1 HAVING count(*) FILTER (WHERE sell_px IS NOT NULL) > 0
      ORDER BY net_kd DESC;`, [fromDay, toDay]);
  return rows;
}

/**
 * Execution quality — the real report while the money is still small.
 * Median fill and lift, fill rate, and how often the spread was crossed.
 */
async function executionStats(fromDay, toDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE side='BUY')                          AS buys_posted,
       count(*) FILTER (WHERE side='BUY'  AND status='FILLED')     AS buys_filled,
       count(*) FILTER (WHERE side='SELL' AND status='FILLED')     AS sells_filled,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM (resolved_at-posted_at))/60)
         FILTER (WHERE side='BUY'  AND status='FILLED')            AS median_fill_min,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM (resolved_at-posted_at))/60)
         FILTER (WHERE side='SELL' AND status='FILLED')            AS median_lift_min,
       count(*) FILTER (WHERE side='BUY'  AND price >= book_offer) AS crossed_buy,
       count(*) FILTER (WHERE side='SELL' AND price <= book_bid)   AS crossed_sell
     FROM public.spread_orders
    WHERE trading_day BETWEEN $1 AND $2
      -- CR-14: the moment a position is held overnight it stops being a spread
      -- capture and becomes a directional bet. Its fill timings say nothing
      -- about the passive strategy, so they are kept out of these numbers.
      AND carried_from_day IS NULL
      AND status NOT IN ('CARRIED','AUCTION_SUBMITTED');`, [fromDay, toDay]);
  return rows[0];
}

/* -------------------------------------------------------------- config --- */

async function activeConfig(db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT * FROM public.spread_config ORDER BY version DESC LIMIT 1;`);
  return rows[0] || null;
}

async function saveConfig(payload, note, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `INSERT INTO public.spread_config (version, payload, note)
     SELECT COALESCE(max(version),0)+1, $1, $2 FROM public.spread_config
     RETURNING *;`, [JSON.stringify(payload), note ?? null]);
  return rows[0];
}

module.exports = {
  DDL, ensure, logEvent, validateLeg,
  nextSeq, recordLeg, resolveLeg, updateLeg, deleteLeg, legById,
  legsForDay, legsForContractsTouching, openLegs, eventsForDay,
  openPositions, setCarryState, bumpPeak, trendMap, gapMap, postableMap, resolveDailyCols,
  writeSnapshot, snapshotAt, snapshotTimes,
  pnlByDay, pnlBySymbol, executionStats, unrealised,
  activeConfig, saveConfig,
};
