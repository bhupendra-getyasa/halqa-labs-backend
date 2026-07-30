'use strict';
/*
 * ============================================================================
 *  commission.js — THE single source of truth for what a trade costs.
 * ============================================================================
 * Everything that prices a trade must call this module. Nothing may hard-code
 * a commission rate, a minimum, or a settlement fee.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two separate bugs made every cost number in the system wrong:
 *
 *  1. classification.js applied a FLAT 2 fils/share to every stock regardless
 *     of price. Real KSE commission is a PERCENTAGE, so the true cost is
 *     ~0.003 x price fils/share. Break-even is 667 fils: below that the flat
 *     model overcharges (6.7x too harsh at 100f), above it undercharges.
 *     That flat 2 did not just misreport net_fils — it decided the MARGINAL
 *     profile, so cheap stocks were rejected for a cost they never paid.
 *     KFIC (133f, real 0.40f) and KHOT (212f, real 0.64f) were both charged
 *     2 fils and rejected; KHOT was the best trade of 26-Jul.
 *
 *  2. The 0.500 KD settlement fee on every executed order over 50 KD was not
 *     modelled anywhere. It is charged TODAY and is abolished on 2026-10-01.
 *
 * REGULATORY BASIS
 * ----------------
 * Boursa Kuwait disclosure 23-Jul-2026, CMA approved, effective 2026-10-01.
 *   Premier Market : 10 bps -> 15 bps
 *   Main Market    : 15 bps -> 15 bps  (UNCHANGED — this is our universe)
 *   Funds / ETFs   : 10 bps -> 15 bps
 *   Minimum/side   : 0.250 KD -> 0.500 KD (trades <= 333.33 KD)
 *   Settlement fee : 0.500 KD/executed order > 50 KD -> ABOLISHED
 *   Custodian fee  : 5.000 KD -> ABOLISHED
 *
 * Net effect for Main Market: CHEAPER at every size, because the rate does not
 * change and the settlement fee disappears.
 *
 * DATE-SCHEDULED, NOT A SINGLE VALUE
 * ----------------------------------
 * A cost calculation for date D must use the schedule active on date D. A
 * single global rate silently corrupts every backtest spanning 01-Oct-2026.
 * Always pass the trading day when costing historical data.
 *
 * OPEN QUESTION FOR THE BROKER
 * ----------------------------
 * The disclosure says the settlement fee applies to "executed orders" over
 * 50 KD, which reads as PER SIDE. Modelled per side here. If it is once per
 * round trip, halve settlementKdPerOrder in config.
 * ============================================================================
 */

/** Normalise whatever the caller passes as a market into a schedule key. */
function segmentOf(market) {
  if (!market) return 'MAIN';
  const m = String(market).toUpperCase();
  if (m.includes('PREMIER')) return 'PREMIER';
  if (m.includes('FUND') || m.includes('ETF')) return 'FUND';
  return 'MAIN';
}

/**
 * Pick the schedule in force on `day`.
 * @param {object} cfg  config.COMMISSION
 * @param {Date|string|null} day  trading day; null/undefined = today
 */
function scheduleFor(cfg, day) {
  const list = cfg && Array.isArray(cfg.schedule) ? cfg.schedule : null;
  if (!list || list.length === 0) {
    throw new Error('COMMISSION.schedule is missing — refusing to guess a commission rate');
  }
  const d = day == null ? new Date() : (day instanceof Date ? day : new Date(day));
  const t = d.getTime();
  let chosen = null;
  for (const s of list) {
    const from = s.effectiveFrom ? new Date(s.effectiveFrom).getTime() : -Infinity;
    const to = s.effectiveTo ? new Date(s.effectiveTo + 'T23:59:59Z').getTime() : Infinity;
    if (t >= from && t <= to) { chosen = s; break; }
  }
  // Past the end of every window -> use the latest schedule (forward-compatible).
  if (!chosen) {
    chosen = list.reduce((a, b) => {
      const fa = a.effectiveFrom ? new Date(a.effectiveFrom).getTime() : -Infinity;
      const fb = b.effectiveFrom ? new Date(b.effectiveFrom).getTime() : -Infinity;
      return fb >= fa ? b : a;
    });
  }
  return chosen;
}

/**
 * Cost of ONE side of a trade, in KD.
 * @param {number} notionalKd  shares * price(fils) / 1000
 */
function perSideKd(notionalKd, { cfg, market, day } = {}) {
  const s = scheduleFor(cfg, day);
  if (s.mode === 'fixed') return null;               // caller must use filsPerShare path
  const seg = segmentOf(market);
  const bps = (s.bpsBySegment && s.bpsBySegment[seg] != null) ? s.bpsBySegment[seg] : 15;
  const pct = bps / 10000;
  // The minimum only bites below minAppliesBelowKd where that is specified.
  const minApplies = s.minAppliesBelowKd == null || notionalKd <= s.minAppliesBelowKd;
  const base = minApplies ? Math.max(s.minKdPerSide ?? 0, pct * notionalKd) : pct * notionalKd;
  const settle = (s.settlementKdPerOrder && notionalKd > (s.settlementAppliesAboveKd ?? 0))
    ? s.settlementKdPerOrder : 0;
  return base + settle;
}

/** Round-trip cost in KD (buy + sell). */
function roundTripKd(notionalKd, opts) {
  const side = perSideKd(notionalKd, opts);
  return side == null ? null : 2 * side;
}

/**
 * Round-trip cost expressed in FILS PER SHARE — the unit the engine reasons in.
 * This is the number that must be compared against target_fils / expected move.
 */
function roundTripFilsPerShare(shares, priceFils, opts) {
  const s = scheduleFor(opts.cfg, opts.day);
  if (s.mode === 'fixed') return s.filsPerShare ?? 0;
  if (!shares || shares <= 0 || !priceFils || priceFils <= 0) return 0;
  const notionalKd = (shares * priceFils) / 1000;
  return (roundTripKd(notionalKd, opts) * 1000) / shares;
}

/**
 * Round-trip cost in fils/share for a stock we are only CLASSIFYING, where no
 * share count exists yet. Uses a reference notional (a typical slot) so the
 * percentage and the KD minimum are both applied honestly.
 *
 * This replaces CLASSIFY.commissionFils. Price-dependent, as reality is.
 */
function referenceRoundTripFils(priceFils, opts) {
  const s = scheduleFor(opts.cfg, opts.day);
  if (s.mode === 'fixed') return s.filsPerShare ?? 0;
  if (!priceFils || priceFils <= 0) return 0;
  const refKd = opts.referenceNotionalKd ?? opts.cfg.referenceNotionalKd ?? 500;
  const shares = (refKd * 1000) / priceFils;
  if (shares <= 0) return 0;
  return (roundTripKd(refKd, opts) * 1000) / shares;
}

/**
 * Smallest slot (KD) at which a given spread still clears its own cost.
 * Used to validate budget / maxStocks — see config.TRADING.
 */
function minViableSlotKd(spreadFils, priceFils, opts, minNetKd = 1.0) {
  if (!spreadFils || !priceFils) return null;
  for (let kd = 100; kd <= 20000; kd += 50) {
    const shares = Math.floor((kd * 1000) / priceFils);
    if (shares <= 0) continue;
    const net = (spreadFils * shares) / 1000 - roundTripKd((shares * priceFils) / 1000, opts);
    if (net >= minNetKd) return kd;
  }
  return null;
}

module.exports = {
  segmentOf,
  scheduleFor,
  perSideKd,
  roundTripKd,
  roundTripFilsPerShare,
  referenceRoundTripFils,
  minViableSlotKd,
};
