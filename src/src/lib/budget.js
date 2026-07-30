'use strict';
/*
 * ============================================================================
 *  budget.js — how the budget splits across stocks, and when it must not.
 * ============================================================================
 * The user sets budgetKd and maxStocks in the front end and changes both often.
 * Nothing downstream may hard-code either value.
 *
 * THE FLOOR IS ARITHMETIC, NOT TASTE
 * ----------------------------------
 * Commission has a fixed component: the KD minimum per side, plus (until
 * 01-Oct-2026) a 0.500 KD settlement fee per executed order over 50 KD. Fixed
 * costs do not shrink when the slot shrinks, so past a point the cost of a round
 * trip exceeds the spread being captured. Measured, 150f stock, 1-fil spread:
 *
 *   slot   250 KD ->  1,600 sh -> round trip 1.72 KD -> net -0.12   LOSS
 *   slot   500 KD ->  3,300 sh -> round trip 2.49 KD -> net +0.81
 *   slot 1,000 KD ->  6,600 sh -> round trip 3.97 KD -> net +2.63
 *   slot 2,500 KD -> 16,600 sh -> round trip 8.47 KD -> net +8.13
 *
 * So a 500 KD budget supports ONE stock, not two. Splitting it turns a working
 * trade into a losing one. This module refuses that split loudly rather than
 * silently sizing into a negative-expectancy position.
 *
 * From 01-Oct-2026 the settlement fee is abolished and the floor drops from
 * ~500 KD to ~350 KD, so the supported stock count roughly doubles at every
 * budget without the user changing anything.
 * ============================================================================
 */
const COMMISSION = require('./commission');

/** Floor for one slot, given the schedule in force on `day`. */
function minSlotKd(cfg, tradingCfg, day) {
  if (tradingCfg && tradingCfg.minSlotKd != null) return tradingCfg.minSlotKd;
  const sched = COMMISSION.scheduleFor(cfg, day);
  const table = (tradingCfg && tradingCfg.minSlotKdByRegime) || {};
  return table[sched.id] != null ? table[sched.id] : 500;
}

/** Largest number of stocks a budget can support without breaching the floor. */
function maxSupportedStocks(budgetKd, cfg, tradingCfg, day) {
  const floor = minSlotKd(cfg, tradingCfg, day);
  if (!budgetKd || budgetKd <= 0 || !floor) return 0;
  return Math.max(0, Math.floor(budgetKd / floor));
}

/**
 * Validate a budget / maxStocks pair.
 * Returns { ok, slotKd, minSlotKd, maxSupported, reason }.
 * Never throws — the caller decides whether to surface or hard-fail.
 */
function validate(budgetKd, maxStocks, cfg, tradingCfg, day) {
  const floor = minSlotKd(cfg, tradingCfg, day);

  /*
   * CR-14. Capital locked in a carried position is NOT available today.
   * `budgetKd` arrives already net of it (the service subtracts committedKd
   * before calling), but the reason string has to say so — otherwise the screen
   * reports "budget too small" when the real answer is "your money is in
   * EQUIPMENT". Those need different actions.
   */
  const committed = Number(tradingCfg?.committedKd || 0);
  const maxSupported = maxSupportedStocks(budgetKd, cfg, tradingCfg, day);
  if (!budgetKd || budgetKd <= 0) {
    return {
      ok: false, slotKd: null, minSlotKd: floor, maxSupported: 0, committedKd: committed,
      reason: committed > 0
        ? `All capital is committed — ${committed.toFixed(0)} KD is held in an open position. ` +
          'Nothing can be opened until it is closed or the budget is raised.'
        : 'budgetKd must be > 0',
    };
  }
  if (!maxStocks || maxStocks < 1) {
    return { ok: false, slotKd: null, minSlotKd: floor, maxSupported, reason: 'maxStocks must be >= 1' };
  }
  const slotKd = budgetKd / maxStocks;
  if (tradingCfg && tradingCfg.enforceSlotFloor === false) {
    return { ok: true, slotKd, minSlotKd: floor, maxSupported, committedKd: committed, reason: null };
  }
  if (slotKd < floor) {
    return {
      ok: false, slotKd, minSlotKd: floor, maxSupported, committedKd: committed,
      reason: (committed > 0
        ? `${committed.toFixed(0)} KD is committed to an open position, leaving ${budgetKd.toFixed(0)} KD. `
        : '') +
        `A budget of ${budgetKd} KD supports at most ${maxSupported} stock(s). ` +
              `Splitting it ${maxStocks} ways gives ${slotKd.toFixed(0)} KD per stock, below the ` +
              `${floor} KD floor — the fixed part of the commission would exceed the spread capture.`,
    };
  }
  return { ok: true, slotKd, minSlotKd: floor, maxSupported, committedKd: committed, reason: null };
}

/**
 * Net KD per round trip for one stock at the configured slot size.
 * This is the gate that decides whether a stock belongs in the universe AT THIS
 * BUDGET. The same stock can pass at 2500 KD and fail at 500 KD — THURAYA on
 * 26-Jul was +3.51 at 2500 and -0.10 at 500, which is why the universe must be
 * recomputed whenever budgetKd or maxStocks changes.
 */
function netPerRoundTripKd({ priceFils, spreadFils, slotKd, lotSize = 1000, market, day }, cfg) {
  if (!priceFils || !spreadFils || !slotKd) return null;
  const raw = (slotKd * 1000) / priceFils;
  const shares = Math.floor(raw / lotSize) * lotSize;
  if (shares <= 0) return null;
  const notionalKd = (shares * priceFils) / 1000;
  const cost = COMMISSION.roundTripKd(notionalKd, { cfg, market, day });
  return ((spreadFils * shares) / 1000) - cost;
}

/** Does this stock clear its own cost at this slot size? */
function clearsCost(args, cfg, minNetKd = 1.0) {
  const net = netPerRoundTripKd(args, cfg);
  return net != null && net >= minNetKd;
}

module.exports = { minSlotKd, maxSupportedStocks, validate, netPerRoundTripKd, clearsCost };
