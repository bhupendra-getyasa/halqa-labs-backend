'use strict';
/*
 * ============================================================================
 *  exit.js — CR-15. Where the sell goes, and when it moves.
 * ============================================================================
 * Replaces the fixed target. A fixed offer caps the winners and does nothing
 * about the losers, which is the wrong way round.
 *
 * Measured over 160,633 fills across 11 days:
 *
 *   trail from +1, exit at peak-1     1.655 fils      <- shipped
 *   trail from +2, exit at peak-1     1.554
 *   trail from +2, exit at peak-2     1.378
 *   fixed 2 fils                      0.977
 *   fixed 1 fil                       0.787
 *
 * Arming at +1 beats +2 because it catches more moves. Trailing by 1 beats 2
 * because on a 1-fil tick grid a 2-fil trail gives back too much.
 *
 * THREE RULES THAT DECIDE WHETHER THIS WORKS
 * ------------------------------------------
 * 1. THE TRAIL ONLY EVER MOVES UP. A trail that can fall is not a trail, it is
 *    a slowly widening loss. `peakBid` is monotonic and the caller persists it.
 *
 * 2. IT FIRES ON THE FIRST DOWNTICK. Selling into a rising bid is easy — buyers
 *    are lifting and the spread works for you. Selling after the peak rolls
 *    over means chasing a bid that has already gone. Do not wait for
 *    confirmation.
 *
 * 3. IT IS "CUT THE GIVEBACK SHORT", NOT "HOLD FOR MORE". Riding a peak spends
 *    realised profit on a chance at more. The leash stays tight so the giveback
 *    is bounded. Disciplined greed, not aggression.
 *
 * THE ONE PLACE THIS DEPARTS FROM THE CR
 * --------------------------------------
 * CR-15 sets `armAtFils: 1` with `hardTargetFils: null`. On a small slot that
 * arms below break-even — the CR's own CR-13 section shows a 1-fil capture at
 * 800 KD on a 235-fil stock netting -0.06 KD. Trailing out at +1 there books a
 * loss and calls it an exit. With `respectCostFloor` the arm level becomes the
 * greater of +armAtFils and the fils needed to clear the round trip, which is
 * the same "target floor, then trail" shape the hybrid exit was specified with.
 * Set the flag false to follow the CR literally.
 *
 * NOTE ON THE EVIDENCE. 1.655 was modelled on `last_price`, not on fills. A
 * trailing exit means re-posting the offer as the peak moves, which is more
 * orders and more chances not to fill. Real results will be below it.
 * ============================================================================
 */

/** Fils per share the round trip costs at this size. The break-even move. */
function costFloorFils(commissionRoundTripKd, shares) {
  if (!commissionRoundTripKd || !shares || shares <= 0) return 0;
  return (commissionRoundTripKd * 1000) / shares;
}

/** Minutes past midnight, Kuwait (UTC+3). */
function kuwaitMinutes(d = new Date()) {
  const k = new Date(d.getTime() + 3 * 3600000);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}

/**
 * Past the step-down clock?
 *
 * This is a TIME OF DAY test, not an elapsed-time one. On 29 July the entry
 * price 238 printed six times between 12:32 and 12:58 — a step-down at noon
 * exits flat into one of those. By 12:50 the only choices left are the bid,
 * which the rules forbid, or the auction.
 */
function pastStepDown(cfg, nowMinutes = kuwaitMinutes()) {
  const at = String(cfg.stepDownAtClock || '12:00').split(':').map(Number);
  return nowMinutes >= at[0] * 60 + (at[1] || 0);
}

/** The trail only ever moves up. */
function trackPeak(prevPeak, bid) {
  const p = Number(prevPeak), b = Number(bid);
  if (!Number.isFinite(b)) return Number.isFinite(p) ? p : null;
  if (!Number.isFinite(p)) return b;
  return Math.max(p, b);
}

/**
 * Where the sell should sit right now.
 *
 * @param {number} entryPrice   fils you actually paid
 * @param {number} peakBid      highest bid seen since the fill (monotonic)
 * @param {number} currentBid   the bid this tick
 * @param {number} minutesHeld  since the buy filled (reporting only)
 * @param {number} nowMinutes   minutes past midnight, Kuwait — drives the step-down
 * @param {number} floorFils    break-even move, from costFloorFils()
 * @param {object} cfg          CFG.EXIT
 *
 * @returns {{armFils, armed, peakBid, suggestedOffer, sellNow, reason, steppedDown}}
 */
function suggestExit({ entryPrice, peakBid, currentBid, minutesHeld = 0,
                      nowMinutes = kuwaitMinutes(), floorFils = 0, cfg }) {
  const entry = Number(entryPrice);
  if (!Number.isFinite(entry)) return null;

  const mode = cfg.mode || 'trailing';
  const trail = Number(cfg.trailFils ?? 1);

  /*
   * The floor: the first tick that is STRICTLY PROFITABLE, not the one that
   * breaks even.
   *
   * This was Math.ceil(floorFils), which is wrong whenever break-even lands
   * exactly on a tick. EQUIPMENT: 3,500 at 238 costs 3.499 KD round trip, so
   * break-even is 1.000 fils exactly; ceil gives 1 and the app recommended
   * selling at 239 for a trip of +0.001 KD. That is not an exit, it is a free
   * option handed to whoever lifts it. floor()+1 puts the arm on the first tick
   * that actually pays — 240, worth +3.501.
   */
  const armFils = cfg.respectCostFloor
    ? Math.max(Number(cfg.armAtFils ?? 1), Math.floor(floorFils) + 1)
    : Number(cfg.armAtFils ?? 1);

  const floorPrice = entry + armFils;
  const peak = Number.isFinite(Number(peakBid)) ? Number(peakBid) : entry;
  const bid = Number.isFinite(Number(currentBid)) ? Number(currentBid) : peak;

  // Fixed mode keeps the old behaviour so the two can be compared on real fills
  // rather than argued about.
  if (mode === 'fixed') {
    const target = cfg.hardTargetFils != null ? entry + Number(cfg.hardTargetFils) : floorPrice;
    return {
      armFils, armed: false, peakBid: peak, suggestedOffer: target,
      sellNow: false, steppedDown: false,
      reason: `fixed target ${target}`,
    };
  }

  const armed = peak >= floorPrice;

  if (!armed) {
    // Below the floor there is no selling — that floor is what clears
    // commission and the spread. Rule 1 of the hybrid exit.
    const stepped = pastStepDown(cfg, nowMinutes);
    return {
      armFils, armed: false, peakBid: peak, suggestedOffer: floorPrice,
      sellNow: false, steppedDown: stepped,
      reason: stepped
        ? `past ${cfg.stepDownAtClock || '12:00'} — hold at the floor ${floorPrice}, take the smaller win while prints are still coming`
        : `waiting to arm — needs ${floorPrice} (entry ${entry} + ${armFils})`,
    };
  }

  // Armed. The trail sits trailFils under the peak but never under the floor,
  // and never below where it has already been.
  let offer = Math.max(peak - trail, floorPrice);

  // Step down: an armed position that has not resolved has been giving back
  // spread for 45 minutes. Drop to the floor and take the smaller win.
  const steppedDown = pastStepDown(cfg, nowMinutes);
  if (steppedDown) offer = floorPrice;

  // Fires on the FIRST downtick, not on confirmation.
  const sellNow = bid <= offer && bid >= floorPrice;

  return {
    armFils, armed: true, peakBid: peak, suggestedOffer: offer, sellNow, steppedDown,
    reason: steppedDown
      ? `past ${cfg.stepDownAtClock || '12:00'} — stepped down to ${floorPrice}; after 12:50 only the bid or the auction remain`
      : sellNow
        ? `bid ${bid} hit the trail — sell into what is still there, do not wait`
        : `peak ${peak}, trailing ${trail} behind it at ${offer}`,
  };
}

module.exports = { costFloorFils, trackPeak, suggestExit, kuwaitMinutes, pastStepDown };
