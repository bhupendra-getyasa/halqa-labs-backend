#!/usr/bin/env node
'use strict';
/*
 * ============================================================================
 *  seed_28jul_live.js — the first live SPREAD session
 * ============================================================================
 * 28 July 2026. Real money, 500 KD, AQAR. Not paper.
 *
 * Three contracts:
 *   C1  buy 111 x 4,500 @ 09:11  ->  sell 112 @ 09:30   +1.995 KD
 *   C2  buy 112 x 4,500 @ 10:07  ->  sell 113 @ 11:03   +1.981 KD
 *   C3  buy 111 x 5,000 @ 09:59  ->  cancelled 10:07, NEVER FILLED
 *
 * C3 is on the record deliberately. It sat behind a queue of 836,945 that grew
 * to 1,011,045 while price walked from 111 to 113, and it explains the session
 * better than either winning trade. Delete it and the fill rate reads 2 of 2
 * instead of 2 of 3 — which is the single number this whole strategy is being
 * judged on right now.
 *
 * Note C3's size: 5,000 shares against a suggested 4,500. Both are stored, so
 * the drift between advice and action stays measurable.
 *
 * Commission figures are the broker's own, read off the order confirmations —
 * 1.249 / 1.256 / 1.263. They match commission.js to three decimals, which is
 * what confirmed the 0.500 KD settlement fee is charged PER SIDE.
 *
 * Idempotent: refuses to run twice for the same day unless --force.
 *
 *   node seed_28jul_live.js            insert
 *   node seed_28jul_live.js --dry      show, write nothing
 *   node seed_28jul_live.js --force    re-insert
 * ============================================================================
 */
const { pool } = require('../db');
const repo = require('../services/repository');

const DAY = '2026-07-28';
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const kwt = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 6, 28, h - 3, m, 0));   // Kuwait = UTC+3
};

const LEGS = [
  { seq: 1, side: 'BUY',  status: 'FILLED',    price: 111, shares: 4500,
    suggestedPrice: 111, suggestedShares: 4500,
    postedAt: kwt('09:11'), resolvedAt: kwt('09:16'),
    bookBid: 110, bookBidQty: 764042, bookOffer: 112, bookOfferQty: 132958,
    queueAheadQty: 0, queueSharePct: 0, spreadFils: 2,
    commissionKd: 1.249, notionalKd: 499.5, entryMode: 'MANUAL',
    note: 'Posted inside the spread — 111 was empty, first in queue. Filled under 5 min.' },

  { seq: 1, side: 'SELL', status: 'FILLED',    price: 112, shares: 4500,
    suggestedPrice: 112, suggestedShares: 4500,
    postedAt: kwt('09:17'), resolvedAt: kwt('09:30'),
    bookBid: 111, bookBidQty: 612811, bookOffer: 112, bookOfferQty: 85100,
    queueAheadQty: 85100, spreadFils: 1,
    commissionKd: 1.256, notionalKd: 504.0, entryMode: 'MANUAL',
    note: 'Lifted in 13 min. Both legs at the posted price, no slippage.' },

  { seq: 2, side: 'BUY',  status: 'FILLED',    price: 112, shares: 4500,
    suggestedPrice: 111, suggestedShares: 4500,
    postedAt: kwt('10:07'), resolvedAt: kwt('10:17'),
    bookBid: 112, bookBidQty: 41241, bookOffer: 113, bookOfferQty: 689619,
    queueAheadQty: 41241, queueSharePct: 1.2, spreadFils: 1,
    commissionKd: 1.256, notionalKd: 504.0, entryMode: 'MANUAL',
    note: 'Stepped up after 111 stalled. Queue 41,241 — filled in 10 min.' },

  { seq: 2, side: 'SELL', status: 'FILLED',    price: 113, shares: 4500,
    suggestedPrice: 113, suggestedShares: 4500,
    postedAt: kwt('10:18'), resolvedAt: kwt('11:03'),
    bookBid: 112, bookBidQty: 41241, bookOffer: 113, bookOfferQty: 689619,
    queueAheadQty: 689619, spreadFils: 1,
    commissionKd: 1.263, notionalKd: 508.5, entryMode: 'MANUAL',
    note: 'Lifted in 45 min behind a 689,619 queue.' },

  { seq: 3, side: 'BUY',  status: 'CANCELLED', price: 111, shares: 5000,
    suggestedPrice: 111, suggestedShares: 4500,
    postedAt: kwt('09:59'), resolvedAt: kwt('10:07'),
    bookBid: 111, bookBidQty: 836945, bookOffer: 112, bookOfferQty: 70169,
    queueAheadQty: 836945, queueSharePct: 0.07, spreadFils: 1,
    commissionKd: 0, notionalKd: 555.0, entryMode: 'MANUAL',
    note: 'NEVER FILLED. Queue 836,945 grew to 1,011,045 while price rose 111->113. Placed 5,000 against a suggested 4,500.' },
];

(async () => {
  await repo.ensure();

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM public.spread_orders WHERE trading_day=$1;`, [DAY]);
  if (rows[0].n > 0 && !FORCE) {
    console.log(`${DAY} already has ${rows[0].n} legs — nothing done. Use --force to re-insert.`);
    await pool.end(); return;
  }
  if (FORCE) await pool.query(`DELETE FROM public.spread_orders WHERE trading_day=$1;`, [DAY]);

  console.log(`${DRY ? 'DRY RUN — ' : ''}seeding ${LEGS.length} legs for ${DAY}\n`);
  for (const l of LEGS) {
    const line = `  C${l.seq} ${l.side.padEnd(4)} ${String(l.price).padStart(4)} x ${String(l.shares).padStart(5)}  ${l.status}`;
    if (DRY) { console.log(line); continue; }
    await repo.recordLeg({ ...l, tradingDay: DAY, symbol: 'AQAR', market: 'Main Market' });
    console.log(line);
  }

  if (!DRY) {
    const p = await repo.pnlByDay(DAY, DAY);
    const e = await repo.executionStats(DAY, DAY);
    const d = p[0] || {};
    console.log('\n  trips        ', d.trips);
    console.log('  orders / fills', `${d.orders} / ${d.fills}`);
    console.log('  gross         ', Number(d.gross_kd).toFixed(3), 'KD');
    console.log('  commission    ', Number(d.commission_kd).toFixed(3), 'KD');
    console.log('  NET           ', Number(d.net_kd).toFixed(3), 'KD   (expected +3.976)');
    console.log('  median fill   ', e.median_fill_min != null ? `${Number(e.median_fill_min).toFixed(0)} min` : '—');
    console.log('  median lift   ', e.median_lift_min != null ? `${Number(e.median_lift_min).toFixed(0)} min` : '—');
    console.log('  spread crossed', Number(e.crossed_buy) + Number(e.crossed_sell), '(must be 0)');
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
