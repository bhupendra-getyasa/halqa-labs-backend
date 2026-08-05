'use strict';
/*
 * ============================================================================
 *  SPREAD — screener
 * ============================================================================
 * Turns a book into an answer to one question: at MY budget, does this stock's
 * spread cover its own round-trip fee, and can I actually get filled?
 *
 * There is no prediction in this file and there must not be. Every input is
 * observable right now — price, spread, depth, trades — and every output is
 * arithmetic over the commission schedule. If a future edit adds a momentum
 * term or a score, it belongs in a different strategy.
 *
 * Reads `stock_quotes` only. Commission comes from live-engine/commission.js so
 * the numbers match the broker exactly (verified to three decimals against a
 * real fill on 28-Jul: 499.5 order value -> 1.249 KD commission).
 * ============================================================================
 */
const COMMISSION = require('./commission');
const BUDGET = require('./budget');
const CFG = require('./spread.config');

const num = (v) => (v == null ? null : Number(v));

/**
 * Economics for one symbol at one slot size.
 * Returns every intermediate value — the UI shows them, and a screen that
 * cannot explain its own verdict is not trustworthy.
 */
function economics(row, slotKd, opts = {}) {
  const bid = num(row.bid), offer = num(row.offer), price = num(row.last_price);
  const bidQty = num(row.bid_qty) || 0;
  if (!bid || !offer || offer <= bid || !slotKd) return null;

  const spread = offer - bid;
  const lot = opts.lotSize ?? 100;

  /*
   * CR-13. WHERE the order sits, not just what it is worth.
   *
   * With a gap to post inside, you become the best bid at bid+1 and your queue
   * ahead is ZERO — the level being reached IS the fill. Joining the queue at
   * the bid means price reaching your level usually is not your fill: 836,945
   * ahead never filled, 73,595 ahead watched 240 trade twice on 29-Jul.
   *
   * Posting inside costs a fil of capture and buys certainty. On a 1-fil spread
   * there is no inside to post at — bid+1 IS the offer, and crossing is a bug,
   * not a fallback. That case is a WAIT, decided in verdict().
   */
  const gapCfg = opts.gapCfg || CFG.GAP;
  const canPostInside = spread >= 2 && gapCfg.preferInside !== false;
  const entryPlacement = canPostInside ? 'INSIDE' : 'QUEUED';
  const entryPrice = canPostInside ? bid + 1 : bid;
  const exitPrice = offer;
  const captureFils = exitPrice - entryPrice;
  const queueAheadQty = canPostInside ? 0 : bidQty;

  const shares = Math.floor((slotKd * 1000) / entryPrice / lot) * lot;
  if (shares <= 0) return null;

  const notionalKd = (shares * entryPrice) / 1000;
  const commCfg = opts.commissionCfg;
  const market = row.market;
  const day = opts.day;

  const roundTripKd = COMMISSION.roundTripKd(notionalKd, { cfg: commCfg, market, day });
  // Gross is what YOU capture from where you actually post, not the headline
  // spread. Posting inside gives up a fil and the number has to say so.
  const grossKd = (captureFils * shares) / 1000;
  const netKd = grossKd - roundTripKd;

  const bidDepthKd = (bidQty * bid) / 1000;
  // Your order as a share of the resting bid. THE field, per 28-Jul.
  // Posting inside means nothing is ahead of you, so the ratio is not a queue
  // risk at all — it is reported as 0 rather than as a wall.
  const queueSharePct = canPostInside ? 0
    : (bidDepthKd > 0 ? (100 * notionalKd) / bidDepthKd : Infinity);

  // Break-even move in fils. The exit floor is built on this, and CR-15's
  // armAtFils: 1 sits below it on small slots.
  const breakEvenFils = shares > 0 ? (roundTripKd * 1000) / shares : null;

  return {
    symbol: row.symbol,
    market: market || null,
    price, bid, offer, spread,
    entryPlacement, entryPrice, exitPrice, captureFils, queueAheadQty,
    breakEvenFils,
    trend: opts.trend || null,
    trendChangeFils: opts.trendChangeFils ?? null,
    gapPct: opts.gapPct ?? null,
    postablePct: opts.postablePct ?? null,
    shares, notionalKd,
    bidQty, bidDepthKd,
    offerQty: num(row.offer_qty) || 0,
    trades: num(row.trades) || 0,
    roundTripKd,
    grossKd,
    netKd,
    queueSharePct,
    // Fee as a share of gross. Uncomfortable on purpose: at 500 KD it is ~56%,
    // which is the whole argument for size and for the 01-Oct change.
    feePctOfGross: grossKd > 0 ? (100 * roundTripKd) / grossKd : null,
  };
}

/**
 * Verdict for one economics row.
 * `tradeable` requires BOTH the money and the queue to work. A stock that
 * clears its fee but sits behind a wall is not an opportunity — it is the order
 * that never filled on 28-Jul.
 */
function verdict(e, screen = CFG.SCREEN, opts = {}) {
  /*
   * opts.trend / opts.gapPct are the PER-SYMBOL values consumed by economics().
   * The config objects are opts.trendCfg / opts.gapCfg. These were both called
   * `trend` and `gap`, so verdict() read the string 'RISING' as its config and
   * every trend rule silently evaluated against undefined — the block never
   * fired and every weight came back 1.
   */
  const gapCfg = opts.gapCfg || CFG.GAP;
  const trendCfg = opts.trendCfg || CFG.TREND;
  const fail = [];
  if (e.price < screen.minPriceFils || e.price > screen.maxPriceFils) fail.push('price band');
  if (e.spread < screen.minSpreadFils) fail.push('no spread to collect');
  if (e.spread > screen.maxSpreadFils) fail.push(`spread ${e.spread}f too wide`);
  if (e.trades < screen.minTradesToday) fail.push(`only ${e.trades} trades`);
  if (e.bidDepthKd < screen.minBidDepthKd) fail.push('cannot exit');

  /*
   * CR-13 liquidity floor. A WIDE SPREAD AND A DEAD TAPE ARE THE SAME FACT, and
   * this is the guard that stops gapPct rewarding the second one. KAMCO screens
   * at 67.9% gap on 86 trades a day, 8 of them in the first ninety minutes.
   */
  if (gapCfg.minTradesPerDay && e.trades < gapCfg.minTradesPerDay) {
    fail.push(`${Math.round(e.trades)} trades/day — below the ${gapCfg.minTradesPerDay} floor`);
  }

  /*
   * GATE 2. How OFTEN the bid depth is right-sized for this slot, not whether
   * it happens to be right now. The instantaneous queue check below still
   * applies; this is the one that says whether the stock is postable at all.
   */
  if (gapCfg.minPostablePct != null && e.postablePct != null
      && e.postablePct < gapCfg.minPostablePct) {
    fail.push(`postable on only ${Math.round(e.postablePct)}% of ticks — ` +
              `depth is right-sized for ${Math.round(e.postablePct)}% of the session, ` +
              `needs ${gapCfg.minPostablePct}%`);
  }

  const moneyOk = e.netKd >= screen.minNetPerRoundTripKd;
  if (!moneyOk) fail.push(`net ${e.netKd.toFixed(2)} below floor`);

  /*
   * Queue.
   *
   * The "under 2% means you sit behind a wall" test only makes sense for a
   * QUEUED entry. Posting INSIDE the spread puts nothing ahead of you by
   * construction — queue share is zero because the queue is empty, which is the
   * best case on the board, not the worst. Reading that zero through the
   * queued-entry rule marked every gap entry "218,494 ahead, you would not
   * fill", i.e. it rejected precisely the setup CR-13 exists to prefer.
   *
   * Size still matters on the way out, so the upper test is kept for both:
   * the depth beneath you is what you have to sell back into.
   */
  /*
   * THE QUEUE GATE READS DIFFERENTLY BY PLACEMENT.
   *
   * The band is 5-30% of the resting bid — under 5% you are behind a wall,
   * over 30% you ARE the book. But posting INSIDE the gap at bid+1 tick puts
   * nobody ahead of you, so queue share against the bid is ZERO by construction.
   * That is the best case on the board, not a failure, and applying the lower
   * bound to it rejects exactly the setup CR-13 exists to prefer.
   *
   *   QUEUED  -> your order as a share of the resting bid. Both bounds apply.
   *   INSIDE  -> nobody ahead. Only the upper bound applies, measured against
   *              the depth BENEATH you, because that is what you sell back into.
   *
   * Both numbers are emitted so the card can show them separately. One field
   * doing both jobs meant neither.
   */
  const depthSharePct = e.bidDepthKd > 0 ? (100 * e.notionalKd) / e.bidDepthKd : Infinity;
  const inside = e.entryPlacement === 'INSIDE';

  let queueReason = null;
  if (!inside && e.queueSharePct < screen.minQueueSharePct) {
    queueReason = `queue ${e.queueSharePct.toFixed(1)}% — ` +
      `${Math.round(e.bidQty).toLocaleString()} shares ahead of you`;
  } else if (depthSharePct > screen.maxQueueSharePct) {
    queueReason = depthSharePct >= 100
      ? 'you would be the book'
      : `${depthSharePct.toFixed(0)}% of the depth — you move the book on the way out`;
  }
  const queueOk = queueReason === null;

  const structuralOk = fail.length === 0 || (fail.length === 1 && !moneyOk);

  /*
   * CR-13 WAIT. A 1-fil spread has no gap to post inside, so the only entry is
   * a queued one — and the screen must say "no gap, wait" rather than present a
   * queued order as an opportunity. At 800 KD on a 235-fil stock a 1-fil
   * capture nets -0.06 KD. That is what happened on 29-Jul.
   */
  const needsGap = e.entryPlacement === 'QUEUED' && gapCfg.allowQueuedEntry === false;
  const waitReason = needsGap
    ? `no gap — 1-fil spread, only a queued entry is possible. Wait for ${e.bid}/${e.bid + 2}.`
    : null;

  /*
   * CR-12 direction. Blocking is deliberately not a hard reject: it is demoted,
   * visible, with the reason on the row. Hiding the rule teaches nothing, and
   * the decision stays yours.
   */
  /*
   * Direction WARNS. `block` is empty by config (CR-12B) but the code must not
   * rely on that alone — `mode` is the explicit switch, so setting block back to
   * ['FALLING'] without also setting mode:'block' does nothing. One reading of
   * intent, not two.
   */
  const trendWarn = trendCfg.enabled && e.trend === 'FALLING';
  const blocked = trendCfg.mode === 'block'
    && trendCfg.enabled && e.trend && (trendCfg.block || []).includes(e.trend);
  const trendReason = trendWarn
    ? `falling ${Math.abs(Math.round(e.trendChangeFils ?? 0))} fils over ${trendCfg.lookbackDays} days — ` +
      'an unlifted offer here costs 17x more. Warning only: this filter scored ' +
      'one modelled save against three real costs.'
    : null;

  const hardFails = fail.filter((f) => !f.startsWith('net '));
  const tradeable = moneyOk && queueOk && !needsGap && !blocked && hardFails.length === 0;

  const state = tradeable ? 'TRADE'
    : needsGap && hardFails.length === 0 ? 'WAIT'
    : (moneyOk && structuralOk && (blocked || !queueOk)) ? 'DEMOTED'
    : 'REJECT';

  // Rank multiplier. netKd answers "is it worth it"; the trend weight answers
  // "will it come back to me". Ranking on netKd alone is what put EMIRATES top
  // on 28-Jul for a trade that would have lost 57.38 KD.
  const trendWeight = (trendCfg.expectedFilsByTrend || {})[e.trend] ?? 1;
  const rankScore = e.netKd * trendWeight;

  /*
   * THE GATES, AS DATA.
   *
   * Every row on the screen shows all four, passing or failing. Each of the
   * three documented bad recommendations came from skipping exactly one —
   * EMIRATES ranked on net while falling, KAMCO on gap frequency at 86 trades a
   * day, MKHZN with a bid that is a wall 77% of the time. Emitting only the
   * verdict would let the screen show winners without the reasoning that would
   * have caught them, so the gates travel with the row.
   */
  const gates = [
    { label: 'Net', ok: moneyOk,
      value: Number.isFinite(e.netKd) ? `${e.netKd >= 0 ? '+' : '−'}${Math.abs(e.netKd).toFixed(2)}` : '—' },
    /*
     * The Queue pill is QUEUE SHARE, not postable-%. Those are different
     * questions and were sharing a label: 63% postable is good (above the 50%
     * floor) while 63% queue share is bad (above the 30% ceiling), so a single
     * pill could not mean anything. Postable-% now has its own.
     */
    { label: 'Queue', ok: queueOk,
      value: inside ? '0% inside' : `${e.queueSharePct.toFixed(1)}%`,
      sub: `${Math.round(e.bidQty || 0).toLocaleString()} sh` },
    { label: 'Postable', ok: e.postablePct == null || e.postablePct >= (gapCfg.minPostablePct ?? 0),
      value: e.postablePct == null ? '—' : `${Math.round(e.postablePct)}%` },
    { label: 'Trend', ok: !blocked, value: e.trend ? e.trend.toLowerCase() : '—' },
    { label: 'Trades', ok: !(gapCfg.minTradesPerDay && e.trades < gapCfg.minTradesPerDay),
      value: `${Math.round(e.trades || 0)}/d` },
  ];

  // One list, in the order the screen reads them, so a row never shows a red
  // pill with no matching sentence underneath it.
  const reasons = [];
  if (waitReason) reasons.push(waitReason);
  if (trendReason) reasons.push(trendReason);
  if (queueReason) reasons.push(queueReason);
  for (const f of fail) reasons.push(f);

  return {
    state,
    gates,
    reasons,
    // Both readings, so the card never has to guess which one it is showing.
    queueSharePct: inside ? 0 : e.queueSharePct,
    depthSharePct: Number.isFinite(depthSharePct) ? depthSharePct : null,
    entryPlacement: e.entryPlacement,
    trendWarn,
    tradeable,
    moneyOk,
    queueOk,
    queueReason,
    waitReason,
    trendReason,
    trendBlocked: !!blocked,
    failures: fail,
    trendWeight,
    rankScore,
    // Money works, queue does not -> shown greyed rather than hidden. KHOT at
    // +10.51 KD and 104% queue is the most instructive row on the screen.
    demoted: state === 'DEMOTED',
  };
}

/**
 * Screen a whole book snapshot.
 * @param {Array}  rows      latest `Trading`-session quote per symbol
 * @param {object} trading   { budgetKd, maxStocks }
 * @param {object} opts      { commissionCfg, day, lotSize }
 */
function screen(rows, trading = CFG.TRADING, opts = {}) {
  const check = BUDGET.validate(
    trading.budgetKd, trading.maxStocks, opts.commissionCfg, trading, opts.day
  );
  const slotKd = check.slotKd;

  const out = { budget: check, tradeable: [], demoted: [], waiting: [], scanned: 0, ceilingFils: null };
  if (!check.ok || !slotKd) return out;

  const trends = opts.trends instanceof Map ? opts.trends : new Map();
  const gaps = opts.gaps instanceof Map ? opts.gaps : new Map();

  for (const r of rows) {
    // Auction quotes are NOT executable. During Close Auction Acceptance every
    // order rests until one clearing price is struck — on 28-Jul IFA showed an
    // offer 29 fils below the market that filled at the market, not at itself.
    // Screening those invents opportunities that cannot be traded.
    if (r.session && r.session !== 'Trading') continue;
    out.scanned++;
    const t = trends.get(r.symbol) || {};
    const e = economics(r, slotKd, {
      ...opts, trend: t.trend || null, trendChangeFils: t.changeFils ?? null,
      gapPct: gaps.get(r.symbol) ?? null,
      postablePct: (opts.postable instanceof Map ? opts.postable.get(r.symbol) : null)?.pct ?? null,
    });
    if (!e) continue;
    const v = verdict(e, opts.screen || CFG.SCREEN, opts);
    const row = { ...e, ...v };
    if (v.state === 'TRADE') out.tradeable.push(row);
    else if (v.state === 'WAIT') out.waiting.push(row);
    else if (v.state === 'DEMOTED') out.demoted.push(row);
  }

  // CR-12: rank on netKd x trend weight, not netKd. gapPct is a TIEBREAKER
  // between stocks that already passed the liquidity floor — never a rank.
  const byRank = (a, b) => (b.rankScore - a.rankScore) || ((b.gapPct ?? 0) - (a.gapPct ?? 0));
  out.tradeable.sort(byRank);
  out.demoted.sort(byRank);
  out.waiting.sort(byRank);
  out.ceilingFils = priceCeiling(slotKd, opts);
  return out;
}

/**
 * Highest price at which a 1-fil spread still clears the floor at this slot.
 * Shown on the budget bar so the constraint is visible before you go hunting:
 * 142f at 500 KD, 294f at 5,000 KD, and both rise on 01-Oct.
 */
function priceCeiling(slotKd, opts = {}) {
  const s = opts.screen || CFG.SCREEN;
  let hi = null;
  for (let p = s.minPriceFils; p <= s.maxPriceFils; p++) {
    const e = economics(
      { symbol: '_', bid: p, offer: p + 1, last_price: p, bid_qty: 1e9,
        trades: 1e6, market: opts.market || 'Main Market' },
      slotKd, opts
    );
    if (e && e.netKd >= s.minNetPerRoundTripKd) hi = p;
  }
  return hi;
}

/** Single-symbol check for the manual search box. Warns, never refuses. */
function inspect(row, trading = CFG.TRADING, opts = {}) {
  const check = BUDGET.validate(
    trading.budgetKd, trading.maxStocks, opts.commissionCfg, trading, opts.day
  );
  if (!check.ok || !check.slotKd) return { budget: check, economics: null, verdict: null };
  const e = economics(row, check.slotKd, opts);
  if (!e) return { budget: check, economics: null, verdict: null };
  return { budget: check, economics: e, verdict: verdict(e, opts.screen || CFG.SCREEN, opts) };
}

module.exports = { economics, verdict, screen, priceCeiling, inspect };
