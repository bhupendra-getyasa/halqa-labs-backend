'use strict';
require('dotenv').config();

/*
 * SPREAD — server entry.
 *
 * Express for health and REST, Socket.IO for the live screen.
 *
 * This project reads `stock_quotes` (written by a separate ingestion scraper)
 * and owns three tables of its own: spread_orders, spread_snapshots,
 * spread_config. It shares nothing with the radar or TMI engines — no fib, no
 * history classification, no profiles. Those were built for a strategy that did
 * not work.
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { pool, ping } = require('./db');
const repo = require('./services/repository');
const svc = require('./services/service');
const { registerSpreadHandlers, startSpreadTicker } = require('./socket');

const PORT = Number(process.env.PORT || 4000);
const TICK_MS = Number(process.env.TICK_INTERVAL_MS || 15000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';           // shared secret; when set, posts must include it
const RESTRICT = String(process.env.RESTRICT_TO_SNAPSHOT || 'false') === 'true';

// Same target table + column order as your original scraper.
const DB_COLUMNS = [
  'scrape_batch_id', 'market', 'symbol', 'code', 'description',
  'last_price', 'last_qty', 'chg', 'pct_chg', 'volume',
  'bid', 'bid_qty', 'offer', 'offer_qty', 'trades',
  'last_trade_date', 'last_trade_time', 'intrinsic_value',
  'open_price', 'high_price', 'low_price', 'session', 'nms',
  'trading_date', 'created_at',
];

// ── helpers ──────────────────────────────────────────────────────────────────
function num(v, signed = false) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/−/g, '-').replace(/ /g, ' ').replace(/,/g, '');
  if (s === '' || s === '—' || s === '-' || s === 'N/A') return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return (!signed && n < 0) ? Math.abs(n) : n;
}
function kuwaitDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait' }).format(new Date());
}
// lutt looks like "20260729110002" -> date 2026-07-29, time 11:00:02
function luttDate(v) { const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
function luttTime(v) { const m = String(v || '').trim().match(/^\d{8}(\d{2})(\d{2})(\d{2})$/); return m ? `${m[1]}:${m[2]}:${m[3]}` : null; }

function toRow(r, batchId, createdAt, tradingDate) {
  return [
    batchId, r.market || null, r.symbol || null, r.code || null, r.description || null,
    num(r.last), num(r.lastQty), num(r.chg, true), num(r.pctChg, true), num(r.volume),
    num(r.bid), num(r.bidQty), num(r.offer), num(r.offerQty), num(r.trades),
    r.lastTradeDate || luttDate(r.lutt), r.lastTradeTime || luttTime(r.lutt), num(r.intrinsicValue),
    num(r.open), num(r.high), num(r.low), r.session || null, num(r.nms),
    tradingDate, createdAt,
  ];
}

// ── optional snapshot-symbol filter (mirrors your original behaviour) ─────────
let snapCache = { at: 0, set: null };
async function allowedSymbols() {
  if (!RESTRICT) return null;
  const now = Date.now();
  if (snapCache.set && now - snapCache.at < 10 * 60 * 1000) return snapCache.set;
  try {
    const res = await pool.query(
      `SELECT DISTINCT UPPER(TRIM(symbol)) AS symbol
         FROM market_stock_snapshots
        WHERE created_at = (SELECT MAX(created_at) FROM market_stock_snapshots)
          AND symbol IS NOT NULL`);
    const set = new Set(res.rows.map((r) => r.symbol).filter(Boolean));
    if (set.size) { snapCache = { at: now, set }; return set; }
  } catch (e) { /* fall through to cached / null */ }
  return snapCache.set;
}

async function saveQuotes(records) {
  if (!records || !records.length) return { inserted: 0, received: 0 };

  let toInsert = records;
  const allow = await allowedSymbols();
  if (allow) {
    toInsert = records.filter((r) => allow.has(String(r.symbol || '').trim().toUpperCase()));
  }
  if (!toInsert.length) return { inserted: 0, received: records.length };

  const batchId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const tradingDate = kuwaitDate();
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    const cols = DB_COLUMNS.join(', ');
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const values = [];
      const tuples = chunk.map((r, ri) => {
        const row = toRow(r, batchId, createdAt, tradingDate);
        const ph = row.map((_, ci) => `$${ri * DB_COLUMNS.length + ci + 1}`);
        values.push(...row);
        return `(${ph.join(', ')})`;
      });
      const sql = `INSERT INTO stock_quotes (${cols}) VALUES ${tuples.join(', ')} ` +
                  `ON CONFLICT (market, symbol, created_at) DO NOTHING`;
      const res = await client.query(sql, values);
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted, received: records.length, saved: toInsert.length };
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
// app.use(express.json());

// Allow the userscript (running on https://www.awsatbroker.com) to POST here.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Parse the body as JSON regardless of Content-Type (the userscript sends it as
// text/plain so the request stays a "simple" CORS request with no preflight).
app.use(express.json({ limit: '8mb', type: () => true }));

let lastBatch = null;

app.get('/health', async (_req, res) => {
  try {
    const t = await ping();
    res.json({ ok: true, db: t, session: svc.isSession(), tradingDay: svc.kuwaitDay() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Same data the socket pushes — useful for debugging without a client.
app.get('/api/screen', async (req, res) => {
  try { res.json(await svc.tick(req.query.date || svc.kuwaitDay())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stock/:symbol', async (req, res) => {
  try { res.json(await svc.detail(req.params.symbol, req.query.date || svc.kuwaitDay())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * Write-path diagnostics.
 *
 * "It is not saving" has several very different causes — the DB user cannot
 * CREATE, the tables are missing, the insert is rejected, or the write worked
 * and the read filtered it out. Guessing between them costs a session. This
 * proves each link in the chain in one request.
 */
app.get('/api/diag', async (_req, res) => {
  const out = { ok: true, checks: [] };
  const add = (name, ok, info) => { out.checks.push({ name, ok, info }); if (!ok) out.ok = false; };
  try {
    await ping(); add('db connect', true, `${process.env.DB_USER}@${process.env.DB_HOST}/${process.env.DB_NAME}`);
  } catch (e) { add('db connect', false, e.message); return res.status(503).json(out); }

  try { await repo.ensure(); add('tables exist', true, 'spread_orders, spread_snapshots, spread_config, spread_events'); }
  catch (e) { add('tables exist', false, e.message); }

  for (const t of ['spread_orders', 'spread_snapshots', 'spread_config', 'spread_events', 'stock_quotes']) {
    try {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.${t};`);
      add(`read ${t}`, true, `${rows[0].n} rows`);
    } catch (e) { add(`read ${t}`, false, e.message); }
  }

  // Insert and roll back — proves the grant without leaving a row behind.
  const client = await pool.connect().catch(() => null);
  if (!client) add('write spread_orders', false, 'could not take a connection');
  else {
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO public.spread_orders
           (trading_day,symbol,seq,side,status,price,shares,posted_at)
         VALUES (CURRENT_DATE,'__DIAG__',0,'BUY','CANCELLED',1,1,now());`);
      await client.query('ROLLBACK');
      add('write spread_orders', true, 'insert + rollback ok');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); add('write spread_orders', false, e.message); }
    finally { client.release(); }
  }

  const day = svc.kuwaitDay();
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE session='Trading')::int AS trading
         FROM public.stock_quotes
        WHERE (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date = $1;`, [day]);
    add(`quotes for ${day}`, rows[0].n > 0,
        `${rows[0].n} rows, ${rows[0].trading} in the Trading session` +
        (rows[0].trading === 0 ? ' — the screen will show no candidates' : ''));
  } catch (e) { add(`quotes for ${day}`, false, e.message); }

  res.status(out.ok ? 200 : 500).json(out);
});

/** The timestamped action log. Analysis only — not rendered anywhere. */
app.get('/api/log', async (req, res) => {
  try { res.json(await repo.eventsForDay(req.query.date || svc.kuwaitDay())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pnl', async (req, res) => {
  try {
    const from = req.query.from || '2026-07-28';   // first live session
    const to = req.query.to || svc.kuwaitDay();
    const [daily, bySymbol, exec] = await Promise.all([
      repo.pnlByDay(from, to), repo.pnlBySymbol(from, to), repo.executionStats(from, to),
    ]);
    res.json({ daily, bySymbol, exec, from, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/quotes', async (req, res) => {
  try {
    if (AUTH_TOKEN && (req.body?.token !== AUTH_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const out = await saveQuotes(records);
    lastBatch = { at: new Date().toISOString(), ...out };
    console.log(`[${lastBatch.at}] received ${out.received}, saved ${out.saved ?? out.received}, inserted ${out.inserted}`);
    res.json(out);
  } catch (e) {
    console.error('save failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);
  registerSpreadHandlers(io, socket);
  socket.on('disconnect', () => console.log('[socket] disconnected', socket.id));
});

(async () => {
  try {
    await repo.ensure();                      // creates the three tables if absent
    console.log('[db] tables ready');
  } catch (e) {
    // Do not exit — the screen still works read-only, and failing loudly here
    // would make a transient DB blip take the whole service down mid-session.
    console.error('[db] ensure failed:', e.message);
  }

  startSpreadTicker(io, TICK_MS);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[spread] listening on ${PORT}, tick ${TICK_MS}ms`);
    console.log(`[spread] AI commentary: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled (no key)'}`);
  });
})();

const shutdown = async (sig) => {
  console.log(`\n[spread] ${sig} — shutting down`);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
