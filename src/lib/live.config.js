'use strict';
/*
 * live.config.js — session times and the commission schedule.
 *
 * COMMISSION IS THE SINGLE SOURCE OF TRUTH FOR WHAT A TRADE COSTS.
 * Nothing anywhere may hardcode a rate. Read it only through lib/commission.js.
 *
 * Date-scheduled per market segment. Source: Boursa Kuwait disclosure
 * 23-Jul-2026 (CMA approved), effective 01-Oct-2026.
 *
 * Verified against a real broker confirmation on 28-Jul-2026:
 *   order value 499.5 KD -> commission 1.249 KD
 * which matches max(0.250, 0.0015 x 499.5) + 0.500 exactly, and is what
 * established that the 0.500 settlement fee is charged PER SIDE.
 *
 * A cost for date D must use the schedule active on date D. A single global
 * rate silently corrupts every calculation spanning 1 October.
 */
module.exports = {
  SESSION: {
    openHour: Number(process.env.SESSION_OPEN_HOUR || 9),
    closeHour: Number(process.env.SESSION_CLOSE_HOUR || 13),
    tzOffsetHours: Number(process.env.SESSION_TZ_OFFSET || 3),   // Asia/Kuwait
  },

  COMMISSION: {
    // Notional used to price a stock we are only screening, before a share
    // count exists.
    referenceNotionalKd: 500,
    schedule: [
      {
        id: 'pre-oct-2026',
        effectiveFrom: null,
        effectiveTo: '2026-09-30',
        mode: 'percentage',
        bpsBySegment: { PREMIER: 10, MAIN: 15, FUND: 10 },
        minKdPerSide: 0.250,
        minAppliesBelowKd: null,
        settlementKdPerOrder: 0.500,      // per EXECUTED ORDER over the threshold
        settlementAppliesAboveKd: 50,
      },
      {
        id: 'post-oct-2026',
        effectiveFrom: '2026-10-01',
        effectiveTo: null,
        mode: 'percentage',
        bpsBySegment: { PREMIER: 15, MAIN: 15, FUND: 15 },
        minKdPerSide: 0.500,
        minAppliesBelowKd: 333.33,        // minimum only bites at or below this
        settlementKdPerOrder: 0,          // ABOLISHED
        settlementAppliesAboveKd: 0,
      },
    ],
  },
};
