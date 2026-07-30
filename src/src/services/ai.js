'use strict';
/*
 * ============================================================================
 *  spread.ai.js — live commentary and Q&A for the SPREAD detail page
 * ============================================================================
 * Explains the book, applies the proven rules, and answers questions using YOUR
 * own logged history.
 *
 * TWO HARD RULES
 * --------------
 * 1. THE ORDER PRICE NEVER COMES FROM THE MODEL. It comes from screener.js /
 *    budget.js. The model receives the price and talks about it. A hallucinated
 *    price is a real trade.
 *
 * 2. IT DOES NOT FORECAST DIRECTION. Roughly 130 honest day-runs across momentum,
 *    mean reversion, position-in-range, fib confirmation and rangeOverCost
 *    produced zero positive results. A confident answer to "will this go up" is
 *    the most expensive thing this could generate, so the prompt forbids it and
 *    the model is told to say so plainly instead.
 *
 * NO FREE SQL. The backend runs fixed queries and hands over the results. A model
 * writing its own queries against a live trading database can block ingestion or
 * silently misread a column — which happened during analysis with a
 * session-cumulative high/low that made every simulated fill succeed by
 * construction. Fixed queries mean the numbers always match the screen.
 *
 * If the API key is missing or the call fails, commentary is simply absent. The
 * screen keeps working — numbers first, words second.
 * ============================================================================
 */
const { pool } = require('../db');
const CFG = require('../lib/spread.config');
const svc = require('./service');
const repo = require('./repository');

const API_URL = 'https://api.anthropic.com/v1/messages';
const lastCallAt = new Map();     // symbol -> ms, rate limit per symbol

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

const SYSTEM = `You are the commentary panel on a passive market-making screen for Boursa Kuwait.

The strategy: post a limit buy at the bid, sell at the offer, never cross the spread.
Profit is the spread minus commission. Direction is irrelevant.

Three rules, proven on real data:
1. Never cross the spread. Crossing cost 2,700-4,300 KD over seven days of testing.
2. Never dump unlifted inventory. Dumping at the bid on a timer gave -5,270 KD;
   waiting for the lift gave +3,014 KD. Same trades, same fills.
3. Queue position decides fills. Live evidence, same stock, same price on 28 Jul:
   queue 0 filled in under 5 minutes; queue 41,241 filled in 10; queue 836,945
   never filled.

Commission is a percentage with a fixed floor, so it hurts small positions hardest.
At 500 KD it is often over half of gross. That is the argument for size, and for
1 October 2026 when the 0.500 KD settlement fee is abolished.

HOW TO ANSWER
- Two or three sentences. Plain, direct, no hedging filler.
- Use the numbers given. Never invent one.
- Never suggest a price. The screen computes prices; you explain them.
- Never predict direction. If asked, say plainly that nothing in the data predicts
  it and redirect to what is observable: the book, the queue, the cost.
- If the right answer is "nothing to do", say that.
- Sentence case. No exclamation marks. No emoji.`;

/** Everything the model is allowed to see, assembled from fixed queries. */
async function buildContext(symbol, day, db = pool) {
  const [detail, legs, exec] = await Promise.all([
    svc.detail(symbol, day, db).catch(() => null),
    repo.legsForDay(day, symbol.toUpperCase(), db).catch(() => []),
    repo.executionStats(day, day, db).catch(() => null),
  ]);
  if (!detail) return null;

  const e = detail.economics, v = detail.verdict, b = detail.book;
  const mins = svc.minutesToClose();

  const lines = [];
  lines.push(`Symbol: ${symbol} (${e?.market || 'Main Market'})`);
  if (b) lines.push(`Book: bid ${b.bid} x ${Number(b.bid_qty).toLocaleString()} / offer ${b.offer} x ${Number(b.offer_qty).toLocaleString()}, spread ${Number(b.offer) - Number(b.bid)} fils, ${b.trades} trades today`);
  if (e) {
    lines.push(`Suggested order (from code, not you): buy ${e.bid} x ${e.shares.toLocaleString()}, sell ${e.offer}`);
    lines.push(`Your order would be ${e.queueSharePct.toFixed(1)}% of the bid queue`);
    lines.push(`Commission ${e.roundTripKd.toFixed(2)} KD round trip, net if lifted ${e.netKd.toFixed(2)} KD, fee is ${e.feePctOfGross?.toFixed(0)}% of gross`);
  }
  if (v && !v.tradeable) lines.push(`Screen verdict: NOT tradeable — ${v.queueReason || v.reasons.join('; ')}`);
  lines.push(`Minutes until the 13:00 close: ${mins}`);

  if (detail.contracts?.length) {
    lines.push('Contracts today:');
    for (const c of detail.contracts) {
      const buy = c.buy ? `buy ${c.buy.price} x ${Number(c.buy.shares).toLocaleString()} (${c.buy.status})` : 'no buy';
      const sell = c.sell ? `sell ${c.sell.price} (${c.sell.status})` : 'no sell';
      const q = c.buy?.queue_ahead_qty != null ? `, queue was ${Number(c.buy.queue_ahead_qty).toLocaleString()}` : '';
      lines.push(`  C${c.seq}: ${buy}, ${sell}, ${c.state}${c.netKd != null ? `, net ${c.netKd.toFixed(2)} KD` : ''}${q}`);
    }
  }
  if (exec?.buys_posted) {
    lines.push(`Your execution today: ${exec.buys_filled}/${exec.buys_posted} buys filled` +
      (exec.median_fill_min != null ? `, median fill ${Number(exec.median_fill_min).toFixed(0)} min` : '') +
      (exec.median_lift_min != null ? `, median lift ${Number(exec.median_lift_min).toFixed(0)} min` : ''));
  }
  return lines.join('\n');
}

async function callClaude(userText, { maxTokens } = {}) {
  const key = apiKey();
  if (!key) return null;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CFG.AI.model,
      max_tokens: maxTokens || CFG.AI.maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

/** Answer a typed question. */
async function ask({ symbol, question, day }, db = pool) {
  if (!CFG.AI.enabled) return null;
  const ctx = await buildContext(symbol, day, db);
  if (!ctx) return 'No live data for that symbol right now.';
  return await callClaude(`${ctx}\n\nQuestion: ${question}`) ||
    'Commentary is unavailable — no API key configured.';
}

/**
 * Unprompted commentary on a material event.
 * Rate-limited per symbol: a panel that talks constantly stops being read.
 */
async function onEvent(io, roomName, { kind, symbol, leg, alert, day }, db = pool) {
  if (!CFG.AI.enabled || !apiKey()) return;
  const sym = symbol || leg?.symbol || alert?.symbol;
  if (!sym) return;

  const last = lastCallAt.get(sym) || 0;
  if ((Date.now() - last) / 1000 < CFG.AI.minSecondsBetweenCalls) return;
  lastCallAt.set(sym, Date.now());

  const ctx = await buildContext(sym, day, db);
  if (!ctx) return;

  const ask = {
    leg: 'An order was just recorded. In two sentences: what does the book say about whether it will fill, and what should happen next?',
    filled: 'The buy just filled. In two sentences: what is the sell side likely to do given the queue, and what should not be done?',
    cancelled: 'An order was cancelled. In two sentences: why did it not fill, and what would need to change?',
    alert: `An alert fired: ${alert?.title}. In two sentences, explain what to do and why.`,
  }[kind] || 'In two sentences, what is worth knowing right now?';

  const text = await callClaude(`${ctx}\n\n${ask}`).catch(() => null);
  if (text) io.to(roomName).emit('spread:comment', { symbol: sym, text, at: new Date().toISOString() });
}

module.exports = { ask, onEvent, buildContext, SYSTEM };
