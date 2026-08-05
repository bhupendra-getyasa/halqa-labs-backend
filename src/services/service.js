'use strict';
/*
 * ============================================================================
 *  spread.service.js — the live loop for the SPREAD strategy
 * ============================================================================
 * Reads the book, screens it at the configured budget, pushes to the socket, and
 * writes a snapshot only when something material changed.
 *
 * DISPLAY IS ALWAYS LIVE. STORAGE IS THROTTLED.
 * Those are separate concerns and conflating them was an early mistake. Every
 * tick goes to the socket, so the screen never lags. A row is written to
 * spread_snapshots only when the qualifying set, the ranking, or a band moved —
 * a queue drifting 68,300 -> 68,325 is worth seeing and not worth storing.
 *
 * SESSION FILTER IS NOT OPTIONAL.
 * Only `Trading` quotes are executable. During Close Auction Acceptance orders
 * rest until one clearing price is struck: on 28-Jul IFA showed an offer 29 fils
 * below the market that filled AT the market. Screening auction quotes invents
 * opportunities that cannot be traded.
 * ============================================================================
 */
const { pool } = require('../db');
const LIVE = require('../lib/live.config');
const SCREENER = require('../lib/screener');
const CFG = require('../lib/spread.config');
const EXIT = require('../lib/exit');
const COMMISSION = require('../lib/commission');
const repo = require('./repository');

const TZ_OFFSET_H = LIVE.SESSION.tzOffsetHours;
const OPEN_H = LIVE.SESSION.openHour;
const CLOSE_H = LIVE.SESSION.closeHour;

/** Kuwait trading day as YYYY-MM-DD. */
/*
 * H3 — THE TRADING DAY IS A SESSION, NOT A CALENDAR DAY.
 *
 * kuwaitDay() rolled at Kuwait midnight, and claims are keyed
 * (trading_day, symbol). Claim a stock at 20:45 UTC, come back at 21:15, and the
 * ticker is querying a different day: 2026-08-03 becomes 2026-08-04 while the
 * market has been shut for eight hours. The claim is still in the table and
 * nothing reads it — "it's gone from Trading".
 *
 * A Kuwait session runs 09:00-13:00. Everything after the close belongs to the
 * session that just ended, up to a cutoff in the small hours. Work done in the
 * evening — which is when this is used — no longer straddles a roll that has
 * nothing to do with the market.
 */
const SESSION_ROLL_H = 4;   // Kuwait 04:00 — five hours before the open

function kuwaitDay(d = new Date()) {
  const k = new Date(d.getTime() + TZ_OFFSET_H * 3600000);
  // Before the roll hour, the session that matters is still yesterday's.
  if (k.getUTCHours() < SESSION_ROLL_H) k.setUTCDate(k.getUTCDate() - 1);
  return k.toISOString().slice(0, 10);
}
function kuwaitNow(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_H * 3600000);
}
function minutesToClose(d = new Date()) {
  const k = kuwaitNow(d);
  return (CLOSE_H * 60) - (k.getUTCHours() * 60 + k.getUTCMinutes());
}
function isSession(d = new Date()) {
  const k = kuwaitNow(d);
  const dow = k.getUTCDay();                  // 0=Sun .. 4=Thu
  if (dow > 4) return false;
  const m = k.getUTCHours() * 60 + k.getUTCMinutes();
  return m >= OPEN_H * 60 && m < CLOSE_H * 60;
}

/** Latest executable quote per symbol today. */
async function latestBook(tradingDay, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (symbol)
            symbol, market, session, last_price, bid, bid_qty, offer, offer_qty,
            trades, volume, created_at
       FROM public.stock_quotes
      WHERE (created_at AT TIME ZONE 'UTC' + interval '${TZ_OFFSET_H} hours')::date = $1
        AND session = 'Trading'
        AND bid > 0 AND offer > bid
      ORDER BY symbol, created_at DESC;`, [tradingDay]);
  return rows;
}

/**
 * Book for one symbol.
 *
 * SCREENING and RECORDING are different questions and must not share a filter.
 * `latestBook` keeps the hard `session = 'Trading'` rule because screening an
 * auction quote invents an opportunity that cannot be traded. But the detail
 * page also has to work at 14:00, on last Thursday, and on a symbol that only
 * ever printed in the auction — and it has to let you record the fill you got.
 *
 * So this prefers the latest Trading quote, falls back to the latest quote of
 * any session that day, and finally to the most recent quote on any day. What
 * it never does is return null and leave the entry form dead, which is what it
 * used to do — the form pre-fill bailed on a missing `economics`, so Save was a
 * no-op with no error anywhere. Every fallback is flagged so the screen can say
 * plainly which one it is looking at.
 */
async function oneSymbol(tradingDay, symbol, db = pool) {
  const cols = `symbol, market, session, last_price, bid, bid_qty, offer, offer_qty,
                trades, volume, created_at`;
  const dayExpr = `(created_at AT TIME ZONE 'UTC' + interval '${TZ_OFFSET_H} hours')::date`;

  // Same day: prefer Trading, else whatever session printed last.
  const sameDay = await db.query(
    `SELECT ${cols} FROM public.stock_quotes
      WHERE ${dayExpr} = $1 AND symbol = $2
      ORDER BY (session = 'Trading') DESC, created_at DESC LIMIT 1;`, [tradingDay, symbol]);
  if (sameDay.rows[0]) {
    const r = sameDay.rows[0];
    return { ...r, executable: r.session === 'Trading', stale: r.session !== 'Trading' ? 'auction' : null };
  }

  // Nothing that day at all — carry the last known book so the page still works.
  const anyDay = await db.query(
    `SELECT ${cols} FROM public.stock_quotes
      WHERE symbol = $1 ORDER BY created_at DESC LIMIT 1;`, [symbol]);
  if (!anyDay.rows[0]) return null;
  return { ...anyDay.rows[0], executable: false, stale: 'other-day' };
}

/* ------------------------------------------------------- snapshot logic -- */

const band = (v, edges) => edges.filter((e) => v >= e).length;

/**
 * Did anything worth storing change?
 * Set membership, ranking, or a band crossing. Not price wobble.
 */
function materialChange(prev, next, snapCfg = CFG.SNAPSHOT) {
  if (!prev) return 'first';
  const pk = prev.map((r) => r.symbol).join(',');
  const nk = next.map((r) => r.symbol).join(',');
  if (pk !== nk) return snapCfg.onSetChange ? 'set changed' : null;

  const pm = new Map(prev.map((r) => [r.symbol, r]));
  for (const r of next) {
    const p = pm.get(r.symbol);
    if (!p) return 'set changed';
    if (band(r.queueSharePct, snapCfg.queueBandPct) !== band(p.queueSharePct, snapCfg.queueBandPct))
      return `${r.symbol} queue band`;
    if (band(r.netKd, snapCfg.netBandKd) !== band(p.netKd, snapCfg.netBandKd))
      return `${r.symbol} net band`;
  }
  return null;
}

/* ------------------------------------------------------------- alerts --- */

/**
 * Only things that need a decision.
 * The 12:50 one is the important one: auction acceptance ends at 13:09, and an
 * unlifted offer at that point has three exits — dump into the bid (pays the
 * spread), carry overnight (gap risk), or the auction. On 28-Jul the auction
 * cleared at or above the 12:59 bid on 123 of 127 symbols.
 */
function buildAlerts(openLegs, screened, now = new Date(), held = [], carried = []) {
  const out = [];
  const mins = minutesToClose(now);

  /*
   * CR-14. The morning alert.
   *
   * On 29-Jul the session ended with 3,500 EQUIPMENT at 238 still open, roughly
   * 7 KD down, and the next day would have opened on a blank screen with no
   * memory of it. Capital that is already committed is the first thing that has
   * to be on the page, before any candidate.
   */
  for (const c of carried) {
    const committed = (Number(c.price) * Number(c.shares)) / 1000;
    const mark = c.mark_bid != null ? Number(c.mark_bid) : null;
    const unreal = mark != null ? ((mark - Number(c.price)) * Number(c.shares)) / 1000 : null;
    out.push({
      level: 'warning', kind: 'carried', symbol: c.symbol, orderId: c.id,
      title: `Holding ${Number(c.shares).toLocaleString()} ${c.symbol} at ${c.price} from ` +
             `${String(c.carried_from_day || c.trading_day).slice(0, 10)}`,
      body: (unreal != null ? `Unrealised ${unreal >= 0 ? '+' : ''}${unreal.toFixed(2)} KD. ` : '') +
            `Capital committed: ${committed.toFixed(0)} KD.` +
            (c.carry_reason ? ` Reason: ${c.carry_reason}` : ''),
      action: 'open',
    });
  }

  /*
   * Unlifted inventory near the close.
   *
   * This used to look only at legs with side='SELL' and status='POSTED', which
   * misses the worse case entirely: a buy that filled and no sell posted yet.
   * That is inventory you own with nothing working to get rid of it, and it is
   * precisely the position rule 2 exists for — dumping into the bid on a timer
   * measured -5,270 KD against +3,014 KD for waiting for the lift.
   *
   * `held` carries both states: `holding` (bought, no sell) and `offered`
   * (bought, sell resting).
   */
  if (mins <= CFG.ALERTS.holdingBeforeCloseMin && mins > 0) {
    for (const h of held) {
      out.push({
        level: 'danger', kind: 'close_holding', symbol: h.symbol,
        seq: h.seq, orderId: h.buyId ?? null,
        title: `Close in ${mins} minutes — still holding ${Number(h.shares).toLocaleString()} ${h.symbol}`,
        body: h.offerPrice
          ? `Offer at ${h.offerPrice} not lifted. Submit to the closing auction rather than selling into the bid.`
          : 'No sell posted. Submit to the closing auction rather than selling into the bid.',
        // CR-14. The alert used to state a rule and give nowhere to put the
        // answer. These are the two legal outcomes, and both are recordable.
        actions: [
          { id: 'auction', label: 'Submit to auction', event: 'spread:auction' },
          { id: 'carry', label: 'Carry overnight', event: 'spread:carry' },
        ],
        action: 'auction',
      });
    }
  }

  for (const l of openLegs) {
    const age = (now - new Date(l.posted_at)) / 60000;
    if (age > CFG.ALERTS.unloggedAfterMin) {
      out.push({
        level: 'warning', kind: 'unresolved', symbol: l.symbol,
        title: `${l.symbol} ${l.side} ${l.price} posted ${Math.round(age)} min ago`,
        body: 'Still unresolved. Log the outcome or your P&L is wrong.',
      });
    }
  }

  if (screened && !screened.budget.ok) {
    out.push({
      level: 'danger', kind: 'budget', title: 'Budget and stock count do not fit',
      body: screened.budget.reason,
    });
  }
  return out;
}

/* --------------------------------------------------------------- state -- */

const days = new Map();   // tradingDay -> { lastRows, lastSnapshotAt, trading }

async function getTrading(db = pool) {
  const saved = await repo.activeConfig(db).catch(() => null);
  return saved?.payload?.trading || CFG.TRADING;
}

/** One tick: screen, alert, maybe snapshot. Returns the socket payload. */
async function tick(tradingDay = kuwaitDay(), db = pool) {
  let d = days.get(tradingDay);
  if (!d) { d = { lastRows: null, lastSnapshotAt: null, trading: await getTrading(db) }; days.set(tradingDay, d); }

  const book = await latestBook(tradingDay, db);

  // CR-12 / CR-13. Direction and gap frequency are per-symbol context the
  // screener cannot derive from a single quote. Cached for the day — neither
  // moves intraday, and re-querying 135 symbols every 15 seconds is waste.
  if (!d.trends || d.contextDay !== tradingDay) {
    /*
     * These used to be `.catch(() => new Map())` and nothing else. When the
     * query failed — wrong table, wrong column names — every symbol silently
     * got trend `null`, weight 1.0, and no falling stock was ever blocked.
     * CR-12 was switched off in production and the screen showed a dash in the
     * Trend column as if that were normal. A rule that fails has to say so.
     */
    d.trends = new Map(); d.gaps = new Map(); d.postable = new Map(); d.contextError = null;
    try {
      d.trends = await repo.trendMap(tradingDay, CFG.TREND.lookbackDays, db);
    } catch (e) {
      d.contextError = `Trend filter is OFF — ${e.message}`;
      console.warn('[spread] trendMap:', e.message);
    }
    try {
      d.gaps = await repo.gapMap(tradingDay, CFG.GAP.gapLookbackSessions, db);
    } catch (e) {
      d.contextError = (d.contextError ? d.contextError + ' · ' : '') + `Gap stats OFF — ${e.message}`;
      console.warn('[spread] gapMap:', e.message);
    }
    try {
      d.postable = await repo.postableMap(tradingDay, d.trading.budgetKd / (d.trading.maxStocks || 1), CFG.GAP, db);
    } catch (e) {
      d.contextError = (d.contextError ? d.contextError + ' · ' : '') + `Postable gate OFF — ${e.message}`;
      console.warn('[spread] postableMap:', e.message);
    }
    if (!d.contextError && d.trends.size === 0) {
      d.contextError = 'Trend filter is OFF — stock_prices_daily returned no rows for this lookback.';
    }
    d.history = await repo.historyCoverage(db)
      .then((h) => ({ ...h, needed: CFG.GAP.baselineDays ?? 20 }))
      .catch(() => null);
    d.contextDay = tradingDay;
  }

  // CR-14. Capital locked in carried positions is NOT available. budget.js
  // would otherwise say you can trade tomorrow when in fact you cannot.
  const carried = await repo.openPositions(tradingDay, db).catch(() => []);
  const carriedFromPriorDays = carried.filter((l) => String(l.trading_day) !== String(tradingDay));
  const committedKd = carriedFromPriorDays
    .reduce((a, l) => a + (Number(l.price) * Number(l.shares)) / 1000, 0);

  const trading = committedKd > 0
    ? { ...d.trading, budgetKd: Math.max(0, d.trading.budgetKd - committedKd), committedKd }
    : d.trading;

  const opts = {
    commissionCfg: LIVE.COMMISSION, day: tradingDay, lotSize: 100,
    trends: d.trends, gaps: d.gaps, postable: d.postable, trendCfg: CFG.TREND, gapCfg: CFG.GAP,
  };
  const screened = SCREENER.screen(book, trading, opts);

  const openLegs = await repo.openLegs(tradingDay, db).catch(() => []);

  // Everything recorded today, grouped per symbol, so the alerts and the header
  // strip both read from the same contract states the detail page shows.
  const allLegs = await repo.legsForDay(tradingDay, null, db).catch(() => []);
  const bySymbol = new Map();
  for (const l of allLegs) {
    if (!bySymbol.has(l.symbol)) bySymbol.set(l.symbol, []);
    bySymbol.get(l.symbol).push(l);
  }
  // Mark prices, so an open position can be valued without a second query.
  const bidBySymbol = new Map(book.map((r) => [r.symbol, r.bid == null ? null : Number(r.bid)]));

  /*
   * THE TRADING BUCKET.
   *
   * The list was a screener and nothing else: a symbol appeared only if it
   * screened well TODAY. So EQUIPMENT — 3,500 shares held at 238 — vanished the
   * moment its spread tightened to 1 fil, and the only trace left was one amber
   * line. You had to search for a stock you owned.
   *
   * Screening decides what to OPEN. It has no business deciding what you can
   * SEE. Anything with your money in it is listed, always, above the candidates.
   */
  const positions = [];   // held inventory only — drives the 12:50 alert
  const tradingRows = [];  // everything with money committed OR an order working
  let dayNetKd = 0, dayTrips = 0, dayCommKd = 0, deployedKd = 0, workingKd = 0;

  for (const [sym, legs] of bySymbol) {
    const bid = bidBySymbol.has(sym) ? bidBySymbol.get(sym) : null;

    for (const c of buildContracts(legs)) {
      if (c.state === 'closed') { dayNetKd += c.netKd; dayCommKd += c.commKd; dayTrips++; continue; }
      if (c.state === 'no fill') continue;

      const entry = c.buy ? Number(c.buy.price) : null;
      const shares = c.buy ? Number(c.buy.shares) : 0;
      const committedKd = c.heldShares > 0 ? (entry * c.heldShares) / 1000 : 0;

      // A posted buy is not a position, but it IS capital at risk: if it fills
      // you have spent it. Reported separately so the two are never confused.
      const working = c.state === 'posted' && c.buy && c.buy.side === 'BUY';
      const atRiskKd = working ? (entry * shares) / 1000 : 0;

      deployedKd += committedKd;
      workingKd += atRiskKd;

      if (c.heldShares > 0) {
        positions.push({
          symbol: sym, seq: c.seq, state: c.state, shares: c.heldShares,
          buyId: c.buy.id, openedOn: c.openedOn, carried: c.carried,
          buyPrice: entry,
          offerPrice: c.sell ? Number(c.sell.price) : null,
          costKd: committedKd,
        });
      }

      tradingRows.push({
        symbol: sym, seq: c.seq, state: c.state, carried: c.carried, openedOn: c.openedOn,
        buyId: c.buy ? c.buy.id : null,
        sellId: c.sell ? c.sell.id : null,
        entry, shares, bid,
        heldShares: c.heldShares,
        offerPrice: c.sell ? Number(c.sell.price) : null,
        committedKd: Number(committedKd.toFixed(2)),
        workingKd: Number(atRiskKd.toFixed(2)),
        unrealisedKd: (c.heldShares > 0 && bid != null)
          ? Number((((bid - entry) * c.heldShares) / 1000).toFixed(3)) : null,
        exit: exitPlan(c, bid == null ? null : { bid }),
        postedMinutes: c.buy
          ? Math.round((Date.now() - new Date(c.buy.posted_at).getTime()) / 60000) : null,
      });
    }
  }

  // Held first, then working orders; oldest first inside each.
  tradingRows.sort((a, b) => (b.heldShares > 0 ? 1 : 0) - (a.heldShares > 0 ? 1 : 0)
    || (b.postedMinutes || 0) - (a.postedMinutes || 0));

  /*
   * END OF SESSION. A day order cannot outlive the close.
   *
   * EQUIPMENT's buy sat at POSTED for 497 minutes — 09:55 to 18:12, five hours
   * after the market shut. Nothing in the system could tell whether that was a
   * fill nobody logged or an order that died, and the difference is an entire
   * position. Past the close these are listed and the day is marked unclosable
   * until each one is answered.
   */
  const sessionOver = minutesToClose(new Date()) <= 0;
  const unresolved = sessionOver
    ? openLegs.map((l) => ({
        id: l.id, symbol: l.symbol, seq: l.seq, side: l.side,
        price: Number(l.price), shares: Number(l.shares),
        postedAt: l.posted_at,
        minutes: Math.round((Date.now() - new Date(l.posted_at).getTime()) / 60000),
      }))
    : [];

  const alerts = buildAlerts(openLegs, screened, new Date(), positions, carriedFromPriorDays);

  /*
   * THE ACCOUNT. Derived from the cash ledger, never typed.
   *
   * budgetKd used to be a number in spread_config that somebody retyped each
   * morning, silently absorbing every profit and loss along the way. Buying
   * power is now the settled cash balance and it compounds by itself.
   */
  const account = await repo.accountSummary(tradingDay, db)
    .catch((e) => { console.warn('[spread] accountSummary:', e.message); return null; });

  // Claims: taken off the board, amount reserved, no order, no cash moved.
  const claims = await repo.listClaims(tradingDay, db).catch(() => []);
  for (const c of claims) {
    if (tradingRows.some((t) => t.symbol === c.symbol)) continue;
    const row = screened.tradeable.concat(screened.demoted, screened.waiting || [])
      .find((r) => r.symbol === c.symbol) || null;
    tradingRows.unshift({
      symbol: c.symbol, seq: null, state: 'picked', carried: false,
      claimedKd: Number(Number(c.amount_kd).toFixed(2)), override: c.override,
      entry: row ? row.entryPrice : null, shares: 0, heldShares: 0,
      bid: row ? row.bid : null, committedKd: 0, unrealisedKd: null,
      suggested: row ? {
        price: row.entryPrice, shares: row.shares,
        costKd: Number(row.notionalKd.toFixed(2)),
        roundTripKd: Number(row.roundTripKd.toFixed(3)),
        netKd: Number(row.netKd.toFixed(3)),
      } : null,
    });
  }

  // Storage decision — display already has everything.
  // queueSharePct is Infinity when the bid side is empty; toFixed keeps it and
  // JSON turns it into null downstream. Normalise here so one code path decides.
  const fin = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
  const compact = screened.tradeable.map((r, i) => ({
    symbol: r.symbol, bid: r.bid, offer: r.offer, spread: r.spread, shares: r.shares,
    queueSharePct: fin(r.queueSharePct, 2), netKd: fin(r.netKd, 3),
    rank: i + 1, demoted: false,
  })).concat(screened.demoted.map((r) => ({
    symbol: r.symbol, bid: r.bid, offer: r.offer, spread: r.spread, shares: r.shares,
    queueSharePct: fin(r.queueSharePct, 2), netKd: fin(r.netKd, 3),
    rank: null, demoted: true, reason: r.queueReason,
  })));

  let reason = materialChange(d.lastRows, compact);
  const stale = d.lastSnapshotAt &&
    (Date.now() - d.lastSnapshotAt) / 60000 >= CFG.SNAPSHOT.maxIntervalMin;
  if (!reason && stale) reason = 'heartbeat';

  if (reason) {
    await repo.writeSnapshot({
      tradingDay, budgetKd: d.trading.budgetKd, maxStocks: d.trading.maxStocks,
      slotKd: screened.budget.slotKd, ceilingFils: screened.ceilingFils,
      scanned: screened.scanned, reason, rows: compact,
    }, db).catch((e) => console.warn('[spread] snapshot', e.message));
    d.lastRows = compact;
    d.lastSnapshotAt = Date.now();
  }

  return {
    strategy: CFG.STRATEGY,
    tradingDay,
    live: isSession(),
    asOf: new Date().toISOString(),
    // The validate() result carries slotKd but not the inputs, so the client had
    // no way to show the budget actually in force and seeded its box from the
    // per-stock slice instead.
    budget: { ...screened.budget, budgetKd: d.trading.budgetKd, maxStocks: d.trading.maxStocks,
              availableKd: trading.budgetKd, committedKd: Number(committedKd.toFixed(2)) },
    ceilingFils: screened.ceilingFils,
    scanned: screened.scanned,
    tradeable: screened.tradeable,
    // The screen calls this `rejected` because that is what it is: everything
    // that did not pass, with the failing gate on the row. `demoted` is kept so
    // an older client does not blank out mid-deploy.
    rejected: [...(screened.waiting || []), ...screened.demoted],
    demoted: screened.demoted,
    waiting: screened.waiting || [],
    account,
    contextError: d.contextError || null,
    trading: tradingRows,
    unresolved,
    openLegs,
    positions,
    carried: carriedFromPriorDays.map((l) => ({
      id: l.id, symbol: l.symbol, seq: l.seq, shares: Number(l.shares),
      buyPrice: Number(l.price), openedOn: l.carried_from_day || l.trading_day,
      committedKd: Number(((Number(l.price) * Number(l.shares)) / 1000).toFixed(2)),
      carryReason: l.carry_reason, status: l.status,
    })),
    committedKd: Number(committedKd.toFixed(2)),
    alerts,
    // Summary strip. The screen was showing candidates and nothing about the
    // money already committed, so there was no way to see at a glance that a
    // position was open.
    day: {
      netKd: Number(dayNetKd.toFixed(3)),
      commissionKd: Number(dayCommKd.toFixed(3)),
      grossKd: Number((dayNetKd + dayCommKd).toFixed(3)),
      trips: dayTrips,
      deployedKd: Number(deployedKd.toFixed(2)),
      // Posted buys are capital at risk, not capital spent. Separate line.
      workingKd: Number(workingKd.toFixed(2)),
      freeKd: Number(Math.max(0, (d.trading.budgetKd || 0) - deployedKd - workingKd).toFixed(2)),
      // 238 x 3,500 = 833 KD went out against an 800 KD budget and nothing said
      // a word. It says one now.
      overBudgetKd: Number(Math.max(0, (deployedKd + workingKd) - (d.trading.budgetKd || 0)).toFixed(2)),
      openPositions: positions.length,
      workingOrders: tradingRows.filter((t) => t.state === 'posted').length,
      unrealisedKd: Number(tradingRows.reduce((a, t) => a + (t.unrealisedKd || 0), 0).toFixed(3)),
      legsRecorded: allLegs.length,
      mustResolve: unresolved.length,
    },
  };
}

/** Manual search. Warns, never refuses — the decision stays yours. */
async function inspectSymbol(symbol, tradingDay = kuwaitDay(), db = pool) {
  const sym = String(symbol || '').trim().toUpperCase();
  const d = days.get(tradingDay) || { trading: await getTrading(db) };
  const row = await oneSymbol(tradingDay, sym, db);
  if (!row) {
    // Still return the budget so the screen can size an order by hand. A symbol
    // with no quote is a reason to warn, never a reason to refuse a recording.
    const budget = SCREENER.inspect({ symbol: sym }, d.trading, {
      commissionCfg: LIVE.COMMISSION, day: tradingDay, lotSize: 100,
    }).budget;
    return { symbol: sym, found: false, budget, economics: null, verdict: null, book: null };
  }
  const r = SCREENER.inspect(row, d.trading, {
    commissionCfg: LIVE.COMMISSION, day: tradingDay, lotSize: 100,
  });
  return {
    symbol: row.symbol, found: true, ...r, book: row,
    executable: row.executable !== false,
    stale: row.stale || null,
  };
}

async function setBudget(budgetKd, maxStocks, tradingDay = kuwaitDay(), db = pool) {
  const trading = { ...CFG.TRADING, budgetKd: Number(budgetKd), maxStocks: Number(maxStocks) };
  await repo.saveConfig({ trading }, `budget ${budgetKd} / ${maxStocks}`, db);
  const d = days.get(tradingDay);
  // Force a snapshot: the universe is budget-dependent and the old rows no
  // longer describe the same question.
  if (d) { d.trading = trading; d.lastRows = null; }
  return trading;
}

/**
 * Group a day's legs into contracts.
 *
 * A contract is the two legs sharing a seq. The state machine is explicit
 * because every downstream number depends on it — the 12:50 alert, the fill
 * rate, and whether the entry form offers you a buy or a sell.
 *
 *   posted   buy resting, nothing owned yet
 *   no fill  buy cancelled or expired without filling — still a result
 *   holding  bought, no sell posted. This is unlifted inventory.
 *   offered  bought, sell resting. Also unlifted inventory.
 *   closed   both legs filled. The only state with a net.
 */
function buildContracts(legs) {
  const bySeq = new Map();
  for (const l of legs) {
    const seq = Number(l.seq);
    if (!bySeq.has(seq)) bySeq.set(seq, { seq, buy: null, sell: null });
    const slot = String(l.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
    /*
     * H1 — WHICH LEG WINS, DETERMINISTICALLY.
     *
     * This was `new Date(l.posted_at) >= new Date(cur.posted_at)`. Every leg
     * recorded in one sitting carries the SAME posted_at, so `>=` was always
     * true and whichever row SQL happened to return last won. Proved with real
     * data: the same three legs fed in two orders produced "holding" and
     * "offered" — a cancelled sell hiding a live resting one, and with it the
     * wrong exit rules, the wrong alert and the wrong trailing offer.
     *
     * Two rules, in order:
     *   1. An UNRESOLVED leg beats a resolved one. A cancelled order and the
     *      order that replaced it are both real; the live one is the one you
     *      are trading.
     *   2. Otherwise the later leg wins, tie-broken on id so the answer never
     *      depends on row order.
     */
    const cur = bySeq.get(seq)[slot];
    if (!cur) { bySeq.get(seq)[slot] = l; continue; }

    const live = (x) => x.status === 'POSTED' || x.status === 'FILLED'
      || x.status === 'CARRIED' || x.status === 'AUCTION_SUBMITTED';
    const curLive = live(cur), newLive = live(l);
    let take;
    if (newLive !== curLive) take = newLive;
    else {
      const t = new Date(l.posted_at) - new Date(cur.posted_at);
      take = t !== 0 ? t > 0 : Number(l.id) > Number(cur.id);
    }
    if (take) bySeq.get(seq)[slot] = l;
  }

  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).map((c) => {
    const buyFilled = c.buy && (c.buy.status === 'FILLED' || c.buy.status === 'CARRIED'
                                || c.buy.status === 'AUCTION_SUBMITTED');
    const sellFilled = c.sell && c.sell.status === 'FILLED';
    const buyDead = c.buy && (c.buy.status === 'CANCELLED' || c.buy.status === 'EXPIRED');

    let state = 'posted', grossKd = null, commKd = null, netKd = null;
    if (buyFilled && sellFilled) {
      state = 'closed';
      const sh = Number(c.buy.shares);
      grossKd = ((Number(c.sell.price) - Number(c.buy.price)) * sh) / 1000;
      commKd = Number(c.buy.commission_kd || 0) + Number(c.sell.commission_kd || 0);
      netKd = grossKd - commKd;
    } else if (buyFilled && c.buy.status === 'AUCTION_SUBMITTED') {
      state = 'auction';
    } else if (buyFilled && c.buy.status === 'CARRIED') {
      state = 'carried';
    } else if (buyFilled && c.sell && c.sell.status === 'POSTED') {
      state = 'offered';
    } else if (buyFilled) {
      state = 'holding';
    } else if (buyDead) {
      state = 'no fill';
    }

    const OPEN = ['holding', 'offered', 'carried', 'auction'];
    const heldShares = OPEN.includes(state) ? Number(c.buy.shares) : 0;

    // CR-14. The contract key: a buy on the 29th and its sell on the 30th are
    // ONE contract. `openedOn` is what the next day has to attach a sell to.
    const openedOn = c.buy ? (c.buy.carried_from_day || c.buy.trading_day) : null;
    const carried = !!(c.buy && c.buy.carried_from_day);

    return { ...c, state, grossKd, commKd, netKd, heldShares, openedOn, carried, open: OPEN.includes(state) };
  });
}

/**
 * CR-15. Where the sell should sit on an open contract, right now.
 * Pure — the peak is persisted on the buy row and only ever moves up.
 */
function exitPlan(contract, book, cfg = CFG.EXIT) {
  if (!contract || !contract.buy || !contract.open) return null;
  const entry = Number(contract.buy.price);
  const shares = Number(contract.buy.shares);
  const commRoundTrip = Number(contract.buy.commission_kd || 0) * 2;
  const bid = book && book.bid != null ? Number(book.bid) : null;
  const peak = EXIT.trackPeak(contract.buy.peak_bid, bid);
  const minutesHeld = contract.buy.resolved_at
    ? (Date.now() - new Date(contract.buy.resolved_at).getTime()) / 60000
    : (Date.now() - new Date(contract.buy.posted_at).getTime()) / 60000;

  return EXIT.suggestExit({
    entryPrice: entry,
    peakBid: peak,
    currentBid: bid,
    minutesHeld,
    floorFils: EXIT.costFloorFils(commRoundTrip, shares),
    // Size travels with the config so the module can price the trip without
    // taking a second argument nobody would remember to pass.
    cfg: { ...cfg, __shares: shares },
  });
}

/**
 * H4 — WOULD THIS SELL LOSE MONEY?
 *
 * C1 on 3 August bought 5,500 at 144 and sold 5,500 at 144. Gross zero,
 * commission 3.376, net −3.38 KD, recorded without a word. The exit module knew
 * break-even was 0.614 fils and the first profitable tick was 145; nothing
 * checked the sell price against the buy on the same contract at the point of
 * entry.
 *
 * WARN, never block — you may have a reason to close flat, and a hard stop on a
 * recording form is worse than a losing trade you meant to make. But it must be
 * said before the save, not discovered in the P&L.
 */
function checkSell({ contract, price, shares, market, day }) {
  if (!contract || !contract.buy) return null;
  const entry = Number(contract.buy.price);
  const sh = Number(shares || contract.buy.shares);
  const px = Number(price);
  if (!Number.isFinite(entry) || !Number.isFinite(px) || !Number.isFinite(sh)) return null;

  const roundTrip = COMMISSION.roundTripKd((entry * sh) / 1000,
    { cfg: LIVE.COMMISSION, market, day });
  const gross = ((px - entry) * sh) / 1000;
  const net = gross - roundTrip;
  if (net > 0) return null;

  const floorFils = EXIT.costFloorFils(roundTrip, sh);
  const firstProfitable = entry + Math.floor(floorFils) + 1;
  return {
    net: Number(net.toFixed(3)),
    entry, firstProfitable,
    message: `Selling at ${px} against an entry of ${entry} nets ${net >= 0 ? '+' : '−'}` +
             `${Math.abs(net).toFixed(2)} KD after ${roundTrip.toFixed(2)} commission. ` +
             `The first profitable tick is ${firstProfitable}.`,
  };
}

/** Detail view for one symbol — book, suggested order, contracts, P&L. */
async function detail(symbol, tradingDay = kuwaitDay(), db = pool) {
  const sym = String(symbol || '').trim().toUpperCase();
  const ins = await inspectSymbol(sym, tradingDay, db);
  // Both ends of any contract touching today, including one whose buy was
  // recorded on an earlier day.
  const legs = await repo.legsForContractsTouching(tradingDay, sym, db);

  /*
   * CR-14. Positions opened on an earlier day are OPEN CONTRACTS, not history.
   * Yesterday's 3,500 EQUIPMENT at 238 has to appear at the top of today's
   * screen or the system has no memory of a real position. These have no leg
   * today at all, so the query above cannot reach them.
   */
  const carriedLegs = (await repo.openPositions(tradingDay, db).catch(() => []))
    .filter((l) => l.symbol.toUpperCase() === sym);

  const byId = new Map();
  for (const l of [...carriedLegs, ...legs]) byId.set(l.id, l);
  const contracts = buildContracts([...byId.values()]);

  // nextSeq must come from the DB, not from contracts.length. They diverge the
  // moment a seq is skipped or a leg is deleted, and a colliding seq silently
  // merges two unrelated contracts into one wrong P&L row.
  const nextSeq = await repo.nextSeq(tradingDay, sym, db);

  const closed = contracts.filter((c) => c.state === 'closed');
  const dayNetKd = closed.reduce((a, c) => a + c.netKd, 0);
  const heldShares = contracts.reduce((a, c) => a + c.heldShares, 0);
  const openContract = contracts.find((c) => c.open) || contracts.find((c) => c.state === 'posted') || null;

  // CR-15. Attach the trailing plan to every open contract so the rule is on
  // the screen rather than in someone's head.
  const book = ins.book || null;
  const withPlans = contracts.map((c) => ({ ...c, exit: exitPlan(c, book) }));

  // Carried first. They are the capital that is already committed.
  withPlans.sort((a, b) => (b.carried ? 1 : 0) - (a.carried ? 1 : 0) || a.seq - b.seq);

  // The step-down is a time of day, so the page can say how long is left rather
  // than making someone read a clock and subtract.
  const stepAt = String(CFG.EXIT.stepDownAtClock || '12:00');
  const [sh, sm] = stepAt.split(':').map(Number);
  const nowMin = EXIT.kuwaitMinutes();
  const leftMin = sh * 60 + (sm || 0) - nowMin;
  const stepDownIn = leftMin > 0
    ? `in ${Math.floor(leftMin / 60)}h ${String(leftMin % 60).padStart(2, '0')}m`
    : 'passed';

  return {
    ...ins,
    symbol: sym,
    tradingDay,
    stepDownAtClock: stepAt,
    stepDownIn,
    contracts: withPlans,
    nextSeq,
    openSeq: openContract ? openContract.seq : null,
    openContract: openContract
      ? { seq: openContract.seq, state: openContract.state, openedOn: openContract.openedOn,
          carried: openContract.carried, buyId: openContract.buy?.id ?? null }
      : null,
    heldShares,
    dayNetKd,
    dayTrips: closed.length,
    carriedCount: withPlans.filter((c) => c.carried).length,
  };
}

module.exports = {
  kuwaitDay, kuwaitNow, isSession, minutesToClose,
  latestBook, oneSymbol, tick, inspectSymbol, setBudget, detail,
  materialChange, buildAlerts, buildContracts, exitPlan, checkSell,
};
