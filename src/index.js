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

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

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
