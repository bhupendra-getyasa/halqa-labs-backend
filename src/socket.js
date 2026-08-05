'use strict';
/*
 * ============================================================================
 *  socket.js — SPREAD events
 * ============================================================================
 * client -> server
 *   spread:subscribe   { date }
 *   spread:budget      { budgetKd, maxStocks, date }
 *   spread:inspect     { symbol, date }           manual search — warns, never refuses
 *   spread:detail      { symbol, date }
 *   spread:leg         { ...leg }                 record a buy or sell
 *   spread:resolve     { id, status, price, shares, resolvedAt, symbol, date }
 *   spread:edit        { id, symbol, date, ...patch }
 *   spread:delete      { id, symbol, date }
 *   spread:history     { date }
 *   spread:snapshot    { date, at }
 *   spread:pnl         { fromDay, toDay }
 *   spread:ask         { symbol, question, date }
 *
 * server -> client
 *   spread:update      { view }
 *   spread:detail      { detail }
 *   spread:saved       { ok, action, order, message }   <-- explicit write receipt
 *   spread:comment     { symbol, text, at }
 *   spread:snapshot    { snapshot }
 *   spread:error       { message, action }
 *
 * EVERY WRITE ANSWERS.
 * -------------------
 * The original build had no receipt of any kind. A record either appeared in
 * the contract table on the next detail push or it did not, and if that push
 * failed for an unrelated reason the row was in the database while the screen
 * said nothing. Worse, an error emitted here was wiped by the next 15-second
 * tick, so a failure could vanish before it was read. Now every mutating
 * handler emits exactly one `spread:saved` — success or failure — and also
 * answers the socket.io ack if the client passed one.
 *
 * THE COMMISSION IS COMPUTED HERE, NOT SENT BY THE CLIENT.
 * ------------------------------------------------------
 * The client used to send `roundTripKd / 2` from the *suggested* order. Edit
 * the share count in the form — the normal case, 4,500 suggested and 5,000
 * placed on 28-Jul — and the stored cost belonged to a trade that never
 * happened. Commission is a function of what actually filled, so it is derived
 * from the price and shares on the row, through the one commission module,
 * using the schedule in force on the trading day.
 * ============================================================================
 */
const svc = require('./services/service');
const repo = require('./services/repository');
const ai = require('./services/ai');
const COMMISSION = require('./lib/commission');
const LIVE = require('./lib/live.config');

const room = (date) => `spread:${date}`;
const bad = (msg) => Object.assign(new Error(msg), { code: 'BAD_LEG' });

/** Cost of one side, from what was actually filled. Never from the client. */
function commissionFor({ price, shares, market, day }) {
  const notionalKd = (Number(price) * Number(shares)) / 1000;
  if (!Number.isFinite(notionalKd)) return { notionalKd: null, commissionKd: null };
  const kd = COMMISSION.perSideKd(notionalKd, { cfg: LIVE.COMMISSION, market, day });
  return {
    notionalKd: Number(notionalKd.toFixed(3)),
    commissionKd: kd == null ? null : Number(kd.toFixed(3)),
  };
}

function registerSpreadHandlers(io, socket) {

  /** One receipt per write, on the event and on the ack. */
  const reply = (ack, action, payload) => {
    const body = { action, ...payload };
    socket.emit('spread:saved', body);
    if (typeof ack === 'function') ack(body);
    if (!body.ok) socket.emit('spread:error', { message: body.message, action });
  };

  const fail = (ack, action, e) => {
    if (!e || e.code !== 'BAD_LEG') console.error(`[spread] ${action}:`, e);
    reply(ack, action, { ok: false, message: e?.message || 'unknown error' });
  };

  socket.on('spread:subscribe', async ({ date } = {}, ack) => {
    try {
      const day = date || svc.kuwaitDay();
      for (const r of [...socket.rooms]) if (String(r).startsWith('spread:')) socket.leave(r);
      socket.join(room(day));
      socket.emit('spread:update', { view: await svc.tick(day) });
      if (typeof ack === 'function') ack({ ok: true, day });
    } catch (e) { socket.emit('spread:error', { message: e.message, action: 'subscribe' }); }
  });

  // Budget change re-frames the whole question — the universe is budget-dependent
  // (THURAYA is -0.10 KD at 500 and +3.51 at 2,500), so everyone gets a fresh view.
  socket.on('spread:budget', async ({ budgetKd, maxStocks, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    try {
      const b = Number(budgetKd), m = Number(maxStocks);
      if (!Number.isFinite(b) || b <= 0) throw bad('budget must be a positive number');
      if (!Number.isFinite(m) || m < 1) throw bad('stocks must be at least 1');
      const trading = await svc.setBudget(b, m, day);
      await repo.logEvent({ tradingDay: day, action: 'BUDGET', detail: trading });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
      reply(ack, 'budget', { ok: true, trading, message: `budget ${b} KD across ${m}` });
    } catch (e) { fail(ack, 'budget', e); }
  });

  /*
   * Manual search returns the SAME shape as `spread:detail`. It used to return
   * economics only — no contracts, no nextSeq — so anything recorded after
   * searching for a symbol was written to the database and then never appeared
   * on screen, which is indistinguishable from not having saved.
   */
  const sendDetail = async (ack, action, symbol, day) => {
    try {
      const detail = await svc.detail(symbol, day);
      socket.emit('spread:detail', { detail });
      // The list shows the search result inline, with its gates and the reason
      // it was left off, so a symbol can be judged without leaving the page.
      if (action === 'inspect') {
        socket.emit('spread:inspected', {
          inspected: detail.economics ? {
            symbol: detail.symbol, bid: detail.economics.bid, spread: detail.economics.spread,
            trades: detail.economics.trades, entryPlacement: detail.economics.entryPlacement,
            gates: detail.verdict?.gates || [], reasons: detail.verdict?.reasons || [],
            tradeable: !!detail.verdict?.tradeable,
            suggested: {
              price: detail.economics.entryPrice, shares: detail.economics.shares,
              costKd: Number(detail.economics.notionalKd.toFixed(2)),
              roundTripKd: Number(detail.economics.roundTripKd.toFixed(3)),
              netKd: Number(detail.economics.netKd.toFixed(3)),
            },
          } : { symbol: detail.symbol, gates: [], reasons: ['no quote for this symbol today'], tradeable: false },
        });
      }
      if (typeof ack === 'function') ack({ ok: true, detail });
    } catch (e) { fail(ack, action, e); }
  };

  socket.on('spread:inspect', ({ symbol, date } = {}, ack) =>
    sendDetail(ack, 'inspect', symbol, date || svc.kuwaitDay()));

  socket.on('spread:detail', ({ symbol, date } = {}, ack) =>
    sendDetail(ack, 'detail', symbol, date || svc.kuwaitDay()));

  /*
   * Record a leg. The client sends what YOU actually did, not what was
   * suggested. Both are stored so the drift is measurable.
   */
  socket.on('spread:leg', async (leg = {}, ack) => {
    const day = leg.tradingDay || svc.kuwaitDay();
    let saved = null;
    try {
      const symbol = String(leg.symbol || '').trim().toUpperCase();
      if (!symbol) throw bad('symbol is required');
      const status = String(leg.status || 'POSTED').toUpperCase();

      // Explicit seq, else the next contract for this symbol today.
      let seq = Number(leg.seq);
      if (!Number.isFinite(seq) || seq <= 0) seq = await repo.nextSeq(day, symbol);

      // Cost from the fill, and only once the leg is actually FILLED — a posted
      // or cancelled order costs nothing and must not carry a commission.
      const { notionalKd, commissionKd } = commissionFor({
        price: leg.price, shares: leg.shares, market: leg.market, day,
      });

      saved = await repo.recordLeg({
        ...leg,
        symbol, seq, status, tradingDay: day,
        notionalKd,
        commissionKd: status === 'FILLED' ? commissionKd : 0,
      });

      // CR-15. Seed the peak at the entry so the trail has a floor to move up
      // from rather than starting at null on the first tick.
      if (status === 'FILLED' && String(leg.side).toUpperCase() === 'BUY') {
        await repo.bumpPeak(saved.id, Number(leg.price)).catch(() => {});
      }

      /*
       * THE MONEY MOVES WITH THE LEG.
       *
       * A fill that does not post cash is the same class of bug as a fill that
       * does not save — the balance quietly stops matching the broker and
       * nothing says so. This throws rather than warns: a leg whose cash failed
       * is worse than no leg at all, because the P&L then reads as if the trade
       * were free.
       */
      await repo.postFillCash(saved, undefined);

      // A claim is spent the moment the order exists.
      await repo.removeClaim(day, symbol).catch(() => {});

      /*
       * H4. A sell that loses money is recorded, and then said out loud. The
       * warning rides on the receipt so it appears in the same place as every
       * other write outcome rather than needing its own channel.
       */
      let warning = null;
      if (String(leg.side).toUpperCase() === 'SELL' && seq) {
        const d = await svc.detail(symbol, day).catch(() => null);
        const c = d && d.contracts.find((x) => String(x.seq) === String(seq));
        const w = svc.checkSell({ contract: c, price: leg.price, shares: leg.shares,
                                  market: leg.market, day });
        if (w) warning = w.message;
      }

      reply(ack, 'leg', {
        ok: true, order: saved, warning,
        message: `C${saved.seq} ${saved.side} ${saved.price} × ${Number(saved.shares).toLocaleString()} saved (${saved.status})`,
      });
    } catch (e) {
      return fail(ack, 'leg', e);
    }

    // The write succeeded. Anything failing from here is a refresh problem, not
    // a save problem, and must not be reported as one.
    try {
      socket.emit('spread:detail', { detail: await svc.detail(saved.symbol, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { console.warn('[spread] refresh after leg:', e.message); }
    ai.onEvent(io, room(day), { kind: 'leg', leg: saved, day }).catch(() => {});
  });

  /** Move a POSTED leg to FILLED / CANCELLED / EXPIRED. */
  socket.on('spread:resolve', async ({ id, status, price, shares, resolvedAt, symbol, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    let updated = null;
    try {
      const existing = await repo.legById(id);
      if (!existing) throw bad(`no order with id ${id}`);

      const st = String(status || '').toUpperCase();
      const px = price != null && price !== '' ? Number(price) : Number(existing.price);
      const sh = shares != null && shares !== '' ? Number(shares) : Number(existing.shares);
      if (!Number.isFinite(px) || px <= 0) throw bad(`price must be a positive number, got "${price}"`);
      if (!Number.isFinite(sh) || sh <= 0) throw bad(`shares must be a positive number, got "${shares}"`);

      // Re-cost on fill: the resolve form can change both price and size.
      const commissionKd = st === 'FILLED'
        ? commissionFor({ price: px, shares: sh, market: existing.market, day }).commissionKd
        : 0;

      updated = await repo.resolveLeg(id, st, resolvedAt, { price: px, shares: sh, commissionKd });
      // Resolving is where a POSTED order becomes real money — or stops being a
      // possibility. Either way the ledger has to agree with the leg.
      await repo.reverseFillCash(id).catch(() => {});
      await repo.postFillCash(updated).catch((e) => console.warn('[spread] cash on resolve:', e.message));
      reply(ack, 'resolve', {
        ok: true, order: updated,
        message: `C${updated.seq} ${updated.side} → ${updated.status}`,
      });
    } catch (e) {
      return fail(ack, 'resolve', e);
    }

    try {
      socket.emit('spread:detail', { detail: await svc.detail(updated.symbol || symbol, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { console.warn('[spread] refresh after resolve:', e.message); }
    ai.onEvent(io, room(day),
      { kind: String(updated.status).toLowerCase(), symbol: updated.symbol, day }).catch(() => {});
  });

  socket.on('spread:edit', async ({ id, symbol, date, tradingDay, ...patch } = {}, ack) => {
    const day = date || tradingDay || svc.kuwaitDay();
    let updated = null;
    try {
      const existing = await repo.legById(id);
      if (!existing) throw bad(`no order with id ${id}`);
      if (patch.price != null || patch.shares != null || patch.status != null) {
        const px = patch.price != null ? Number(patch.price) : Number(existing.price);
        const sh = patch.shares != null ? Number(patch.shares) : Number(existing.shares);
        const st = String(patch.status || existing.status).toUpperCase();
        patch.commissionKd = st === 'FILLED'
          ? commissionFor({ price: px, shares: sh, market: existing.market, day }).commissionKd
          : 0;
      }
      updated = await repo.updateLeg(id, patch);
      // A correction to a FILLED leg rewrites the P&L, so it rewrites the cash.
      await repo.reverseFillCash(id).catch(() => {});
      await repo.postFillCash(updated).catch((e) => console.warn('[spread] cash on edit:', e.message));
      reply(ack, 'edit', { ok: true, order: updated, message: `C${updated.seq} ${updated.side} updated` });
    } catch (e) {
      return fail(ack, 'edit', e);
    }
    try { socket.emit('spread:detail', { detail: await svc.detail(updated.symbol || symbol, day) }); }
    catch (e) { console.warn('[spread] refresh after edit:', e.message); }
  });

  socket.on('spread:delete', async ({ id, symbol, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    let removed = null;
    try {
      removed = await repo.deleteLeg(id);
      await repo.reverseFillCash(id).catch(() => {});
      reply(ack, 'delete', { ok: true, order: removed, message: `C${removed.seq} ${removed.side} removed` });
    } catch (e) { return fail(ack, 'delete', e); }
    try {
      socket.emit('spread:detail', { detail: await svc.detail(removed.symbol || symbol, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { console.warn('[spread] refresh after delete:', e.message); }
  });

  /*
   * CR-14. The two ways a position leaves without crossing the spread.
   *
   * The 12:50 alert used to state a rule and give nowhere to put the answer.
   * Both outcomes are now recordable, and both stamp `carried_from_day` so the
   * contract survives into tomorrow and its P&L attaches to the exit day.
   */
  socket.on('spread:auction', async ({ id, price, symbol, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    let row = null;
    try {
      const existing = await repo.legById(id);
      if (!existing) throw bad(`no order with id ${id}`);
      const px = price != null && price !== '' ? Number(price) : null;
      if (px != null && (!Number.isFinite(px) || px <= 0)) throw bad(`auction price must be positive, got "${price}"`);

      if (px == null) {
        // Submitted, not yet cleared. The auction strikes one price at 13:09.
        row = await repo.setCarryState(id, { status: 'AUCTION_SUBMITTED', exitVenue: 'AUCTION' });
        reply(ack, 'auction', { ok: true, order: row,
          message: `C${row.seq} submitted to the closing auction — record the fill price once it clears` });
      } else {
        // Cleared. Close the contract with a SELL leg at the auction price,
        // keyed to the buy so the pair survives a day boundary.
        row = await repo.setCarryState(id, { status: 'FILLED', exitVenue: 'AUCTION', auctionPrice: px });
        const ckey = row.carried_from_day || row.trading_day;
        const { commissionKd, notionalKd } = commissionFor({
          price: px, shares: row.shares, market: row.market, day,
        });
        const sellLeg = await repo.recordLeg({
          tradingDay: day, symbol: row.symbol, seq: row.seq, side: 'SELL', status: 'FILLED',
          price: px, shares: row.shares, postedAt: new Date(), resolvedAt: new Date(),
          market: row.market, commissionKd, notionalKd,
          carriedFromDay: ckey, exitVenue: 'AUCTION', entryMode: 'MANUAL',
          note: 'closing auction',
        });
        await repo.postFillCash(sellLeg);
        reply(ack, 'auction', { ok: true, order: row,
          message: `C${row.seq} closed in the auction at ${px}` });
      }
    } catch (e) { return fail(ack, 'auction', e); }

    try {
      socket.emit('spread:detail', { detail: await svc.detail(row.symbol || symbol, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { console.warn('[spread] refresh after auction:', e.message); }
  });

  socket.on('spread:carry', async ({ id, reason, symbol, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    let row = null;
    try {
      const existing = await repo.legById(id);
      if (!existing) throw bad(`no order with id ${id}`);
      row = await repo.setCarryState(id, {
        status: 'CARRIED', exitVenue: 'CARRIED',
        carryReason: reason || 'held overnight rather than dumped into the bid',
      });
      reply(ack, 'carry', { ok: true, order: row,
        message: `C${row.seq} ${row.symbol} carried overnight — ` +
                 `${((Number(row.price) * Number(row.shares)) / 1000).toFixed(0)} KD stays committed. ` +
                 'It is a directional bet now and is excluded from the execution statistics.' });
    } catch (e) { return fail(ack, 'carry', e); }

    try {
      socket.emit('spread:detail', { detail: await svc.detail(row.symbol || symbol, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { console.warn('[spread] refresh after carry:', e.message); }
  });

  /* ------------------------------------------------------------ the account */

  socket.on('spread:cash', async ({ fromDay, toDay } = {}) => {
    try {
      const day = toDay || svc.kuwaitDay();
      const [ledger, account, pnl] = await Promise.all([
        repo.cashLedger(fromDay || null, day),
        repo.accountSummary(day),
        repo.pnlByDay('2026-07-01', day).catch(() => []),
      ]);
      socket.emit('spread:cash', {
        ...account,
        ledger,
        realisedKd: Number(pnl.reduce((a, r) => a + Number(r.net_kd || 0), 0).toFixed(3)),
        trips: pnl.reduce((a, r) => a + Number(r.trips || 0), 0),
      });
    } catch (e) { socket.emit('spread:error', { message: e.message, action: 'cash' }); }
  });

  const move = (kind) => async ({ amountKd, note, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    try {
      const amt = Number(amountKd);
      if (!Number.isFinite(amt) || amt <= 0) throw bad('amount must be a positive number');

      if (kind === 'WITHDRAWAL') {
        /*
         * EQUITY IS NOT BUYING POWER. Holding 1,495 KD with 826 of it in a
         * position means exactly 669.23 can leave, and refusing has to say so —
         * "insufficient funds" against a 1,495 KD account reads like a bug.
         */
        const a = await repo.accountSummary(day);
        if (amt > a.settledKd) {
          throw bad(`only ${a.settledKd.toFixed(2)} KD is available — equity is ` +
                    `${a.equityKd.toFixed(2)} but ${a.investedKd.toFixed(2)} is in an open position`);
        }
      }

      const row = await repo.recordCash({
        tradingDay: day, kind, amountKd: kind === 'DEPOSIT' ? amt : -amt, note: note || null,
      });
      const a = await repo.accountSummary(day);
      reply(ack, kind.toLowerCase(), {
        ok: true, order: row,
        message: `${kind === 'DEPOSIT' ? 'Added' : 'Withdrew'} ${amt.toFixed(2)} KD — ` +
                 `buying power is now ${a.buyingPowerKd.toFixed(2)}`,
      });
      socket.emit('spread:cash', { ...a, ledger: await repo.cashLedger(null, day) });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { fail(ack, kind.toLowerCase(), e); }
  };
  socket.on('spread:deposit', move('DEPOSIT'));
  socket.on('spread:withdraw', move('WITHDRAWAL'));

  /*
   * A claim reserves buying power without placing anything. It is what stops the
   * same 669 KD being offered to three stocks at once, and it is deliberately
   * NOT a cash movement — no order exists yet.
   */
  socket.on('spread:claim', async ({ symbol, amountKd, override, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    try {
      const amt = Number(amountKd);
      const a = await repo.accountSummary(day);
      const free = a.buyingPowerKd - a.claimedKd;
      if (!Number.isFinite(amt) || amt <= 0) throw bad('amount must be a positive number');
      if (amt > free) {
        throw bad(`only ${free.toFixed(2)} KD of buying power is free — equity is ` +
                  `${a.equityKd.toFixed(2)} but ${a.investedKd.toFixed(2)} is in an open position`);
      }
      const row = await repo.addClaim(day, symbol, amt, override);
      reply(ack, 'claim', { ok: true, order: row,
        message: `${row.symbol} claimed for ${amt.toFixed(2)} KD — nothing placed yet` });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { fail(ack, 'claim', e); }
  });

  socket.on('spread:unclaim', async ({ symbol, date } = {}, ack) => {
    const day = date || svc.kuwaitDay();
    try {
      const row = await repo.removeClaim(day, symbol);
      if (!row) throw bad(`${symbol} is not claimed`);
      reply(ack, 'unclaim', { ok: true, order: row,
        message: `${row.symbol} released — ${Number(row.amount_kd).toFixed(2)} KD back to buying power` });
      io.to(room(day)).emit('spread:update', { view: await svc.tick(day) });
    } catch (e) { fail(ack, 'unclaim', e); }
  });

  socket.on('spread:history', async ({ date } = {}) => {
    try { socket.emit('spread:history', { times: await repo.snapshotTimes(date || svc.kuwaitDay()) }); }
    catch (e) { socket.emit('spread:error', { message: e.message, action: 'history' }); }
  });

  /*
   * Replay used to be emitted as `spread:update`, which replaced the live view
   * with an object that had no budget, no tradeable list and no alerts — the
   * whole screen blanked until the next tick. It has its own event now and
   * leaves the live view alone.
   */
  socket.on('spread:snapshot', async ({ date, at } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      socket.emit('spread:snapshot', {
        snapshot: await repo.snapshotAt(day, at || new Date()), at, date: day,
      });
    } catch (e) { socket.emit('spread:error', { message: e.message, action: 'snapshot' }); }
  });

  socket.on('spread:pnl', async ({ fromDay, toDay } = {}) => {
    try {
      const from = fromDay || '2026-07-28';
      const to = toDay || svc.kuwaitDay();
      const [daily, bySymbol, exec, open] = await Promise.all([
        repo.pnlByDay(from, to),
        repo.pnlBySymbol(from, to),
        repo.executionStats(from, to),
        repo.unrealised(to).catch(() => []),
      ]);
      // CR-14: realised and unrealised are different claims and must not be
      // added together on the way to the screen.
      socket.emit('spread:pnl', { daily, bySymbol, exec, open, fromDay: from, toDay: to });
    } catch (e) { socket.emit('spread:error', { message: e.message, action: 'pnl' }); }
  });

  socket.on('spread:ask', async ({ symbol, question, date } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      const text = await ai.ask({ symbol, question, day });
      socket.emit('spread:comment', { symbol, text, at: new Date().toISOString(), fromUser: true });
    } catch (e) { socket.emit('spread:error', { message: e.message, action: 'ask' }); }
  });
}

/**
 * Tick loop.
 *
 * It now ticks every room that has listeners, not only today's. Selecting a
 * past date used to leave the client on one frozen frame with no refresh, and
 * no alerts, for as long as it stayed there.
 */
function startSpreadTicker(io, intervalMs = 15000) {
  return setInterval(async () => {
    try {
      for (const [name, members] of io.sockets.adapter.rooms) {
        if (!String(name).startsWith('spread:') || !members.size) continue;
        const day = String(name).slice('spread:'.length);
        const view = await svc.tick(day);
        io.to(name).emit('spread:update', { view });
        for (const a of view.alerts) {
          if (a.level === 'danger') ai.onEvent(io, name, { kind: 'alert', alert: a, day }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[spread] tick', e.message); }
  }, intervalMs);
}

module.exports = { registerSpreadHandlers, startSpreadTicker };
