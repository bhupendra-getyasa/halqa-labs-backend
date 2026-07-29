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
const repo = require('./repository');

const TZ_OFFSET_H = LIVE.SESSION.tzOffsetHours;
const OPEN_H = LIVE.SESSION.openHour;
const CLOSE_H = LIVE.SESSION.closeHour;

/** Kuwait trading day as YYYY-MM-DD. */
function kuwaitDay(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_H * 3600000).toISOString().slice(0, 10);
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
    d.trends = await repo.trendMap(tradingDay, CFG.TREND.lookbackDays, db).catch(() => new Map());
    d.gaps = await repo.gapMap(tradingDay, CFG.GAP.gapLookbackSessions, db).catch(() => new Map());
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
    trends: d.trends, gaps: d.gaps, trendCfg: CFG.TREND, gapCfg: CFG.GAP,
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
  const positions = [];
  let dayNetKd = 0, dayTrips = 0, dayCommKd = 0, deployedKd = 0;
  for (const [sym, legs] of bySymbol) {
    for (const c of buildContracts(legs)) {
      if (c.state === 'closed') { dayNetKd += c.netKd; dayCommKd += c.commKd; dayTrips++; }
      if (c.heldShares > 0) {
        positions.push({
          symbol: sym, seq: c.seq, state: c.state, shares: c.heldShares,
          buyId: c.buy.id, openedOn: c.openedOn, carried: c.carried,
          buyPrice: Number(c.buy.price),
          offerPrice: c.sell ? Number(c.sell.price) : null,
          costKd: (Number(c.buy.price) * c.heldShares) / 1000,
        });
        deployedKd += (Number(c.buy.price) * c.heldShares) / 1000;
      }
    }
  }

  const alerts = buildAlerts(openLegs, screened, new Date(), positions, carriedFromPriorDays);

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
    demoted: screened.demoted,
    waiting: screened.waiting || [],
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
      freeKd: Number(Math.max(0, (d.trading.budgetKd || 0) - deployedKd).toFixed(2)),
      openPositions: positions.length,
      legsRecorded: allLegs.length,
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
    const cur = bySeq.get(seq)[slot];
    // Two legs on the same side and seq: the later one wins for display, but
    // both stay in the DB. Silently dropping one would hide a double-entry.
    if (!cur || new Date(l.posted_at) >= new Date(cur.posted_at)) bySeq.get(seq)[slot] = l;
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
    cfg,
  });
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

  return {
    ...ins,
    symbol: sym,
    tradingDay,
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
  materialChange, buildAlerts, buildContracts, exitPlan,
};
