'use strict';
/*
 * ============================================================================
 *  SPREAD — config
 * ============================================================================
 * Post at the bid, sell at the offer, never cross. Direction is irrelevant; the
 * money is the spread minus the fee.
 *
 * WHY THIS STRATEGY EXISTS
 * ------------------------
 * Every directional rule this project tried lost money — roughly 130 honest
 * day-runs, zero positive. Momentum, mean reversion, position-in-range, fib
 * confirmation, rangeOverCost: all of them needed to predict where price was
 * going, and nothing predicted it.
 *
 * What DID show up, repeatedly, was the cost of transacting:
 *   crossing the spread    -2,700 to -4,300 KD over 7 days
 *   daily churn commission   -800 KD over 110 days on one stock
 *
 * SPREAD is the inversion. You stop paying the spread and start collecting it.
 * First live session (28-Jul-2026, 500 KD): 2 round trips, +3.98 KD, both legs
 * filled at the posted price, no slippage.
 *
 * THE THREE RULES, IN ORDER OF HOW MUCH THEY MATTER
 * -------------------------------------------------
 * 1. NEVER CROSS. A market order is a bug, not a fallback.
 * 2. NEVER DUMP UNLIFTED INVENTORY. Measured over 7 days: dumping at the bid on a
 *    45-minute timer gave -5,270 KD; waiting for the lift gave +3,014 KD. Same
 *    trades, same fills. That single behaviour is the difference.
 * 3. QUEUE POSITION DECIDES EVERYTHING. 28-Jul, same stock, same price:
 *      queue 0 (inside the spread) -> filled in under 5 minutes
 *      queue 41,241                -> filled in 10 minutes
 *      queue 836,945               -> never filled, price walked away
 *
 * WHAT IS NOT HERE, DELIBERATELY
 * ------------------------------
 * No fib radar, no history classification, no profiles or lanes, no
 * rangeOverCost. SPREAD does not read the Live Engine or TMI. It needs the book
 * and the fee schedule; everything else was built for a strategy that did not work.
 * ============================================================================
 */

module.exports = {
  STRATEGY: 'SPREAD',

  // ---- Budget. User-editable, no deploy. --------------------------------
  // The slot floor is arithmetic, not taste: commission has a fixed component
  // (the KD minimum plus, until 01-Oct-2026, a 0.500 KD settlement fee per
  // order) that does not shrink when the slot does. On a 150f stock with a
  // 1-fil spread:
  //     250 KD slot ->  1,600 sh -> cost 1.72 KD -> net -0.12   LOSS
  //     500 KD slot ->  3,300 sh -> cost 2.49 KD -> net +0.81
  //   2,500 KD slot -> 16,600 sh -> cost 8.47 KD -> net +8.13
  TRADING: {
    budgetKd: 500,
    maxStocks: 1,
    minSlotKdByRegime: { 'pre-oct-2026': 500, 'post-oct-2026': 350 },
    enforceSlotFloor: true,
  },

  // ---- Screen. A stock qualifies on arithmetic, not on a forecast. ------
  SCREEN: {
    // Must clear its own round trip by at least this much, AT THE CONFIGURED
    // SLOT SIZE. This is budget-dependent and that is the point: THURAYA at
    // 208f is -0.10 KD on a 500 KD slot and +3.51 KD on 2,500 KD. The universe
    // must be recomputed whenever budgetKd or maxStocks changes.
    minNetPerRoundTripKd: 1.0,

    // Below 1 fil there is nothing to collect. Above 3 the unlifted rate climbs
    // sharply (7-day sample: 1f 13%, 2f 16%, 3f 23%) and you are holding
    // inventory rather than turning it.
    minSpreadFils: 1,
    maxSpreadFils: 3,

    // Price band. The upper end is a soft guard — the real ceiling comes out of
    // minNetPerRoundTripKd at the current budget (142f at 500 KD, 294f at 5,000).
    minPriceFils: 50,
    maxPriceFils: 400,

    // Needs a live tape to fill against.
    minTradesToday: 30,

    // QUEUE — the single most predictive field on the screen.
    // Under 2% you sit behind a wall and never fill. Over 30% you ARE the book:
    // KHOT on 28-Jul showed +10.51 KD/trip and 104% queue share, which is not an
    // opportunity, it is you talking to yourself.
    minQueueSharePct: 2,
    maxQueueSharePct: 30,

    // Exit depth. Getting in is the easy half.
    minBidDepthKd: 1500,
  },

  // ---- Snapshots. Display is always live; only STORAGE is throttled. ----
  // A row is written when the qualifying set gains or loses a symbol, the
  // ranking changes, or a row crosses a band. Price wobble that moves nothing
  // does not write. ~50-150 rows/day instead of ~3,600, and the replay is intact
  // because a stable list genuinely was stable.
  SNAPSHOT: {
    onSetChange: true,
    onRankChange: true,
    queueBandPct: [2, 10, 30],
    netBandKd: [1, 2, 5, 10],
    maxIntervalMin: 30,       // heartbeat, so a quiet hour is still on the record
  },

  // ---- Alerts. Only things that need a decision. ------------------------
  ALERTS: {
    holdingBeforeCloseMin: 10,   // 12:50 — auction acceptance ends 13:09
    unloggedAfterMin: 30,        // a leg posted and never resolved
    queueGrowthPct: 50,          // AQAR went 612k -> 836k -> 1,011k on 28-Jul
    priceMovedFromSuggestion: true,
  },

  // ---- CR-12. Direction. ------------------------------------------------
  // The screener ranked on netKd alone and had no view of price direction. On
  // 28-Jul it put EMIRATES top at +8.22 KD/trip; replayed honestly against the
  // tape that trade LOST 57.38 KD — filled at 148 at 09:36, price never came
  // back, exit in the auction at 138.
  //
  // Completion rate is the wrong metric and made falling stocks look best
  // (DOWN 63.7% vs UP 59.9%), because it ignores what the failures cost.
  // Expected value over 160,633 fills across 11 days:
  //
  //   UP     win 91.5%   avg loss when stuck -0.04   EV +0.912 fils/fill
  //   FLAT   win 80.5%   avg loss when stuck -0.12   EV +0.780
  //   DOWN   win 82.9%   avg loss when stuck -0.67   EV +0.715
  //
  // A falling stock's failures cost 17x more. An unlifted offer on a rising
  // stock is a pause; on a falling stock it is a hole.
  TREND: {
    enabled: true,
    lookbackDays: 3,
    block: ['FALLING'],
    // Rank multiplier. netKd answers "is it worth it"; this answers "will it
    // come back to me". Ranking on netKd alone is what produced EMIRATES.
    expectedFilsByTrend: { RISING: 0.912, FLAT: 0.780, FALLING: 0.715 },
  },

  // ---- CR-13. Where the order sits in the book. -------------------------
  // Posting INSIDE a gap (queue zero, you are the best bid) and JOINING a queue
  // at the bid are not the same trade and were treated as one.
  //
  //   queue 0        -> filled in under 5 minutes
  //   queue 41,241   -> filled in 10 minutes
  //   queue 836,945  -> never filled
  //   queue 73,595   -> 240 traded twice on 29-Jul and still did not fill
  //
  // A 1-fil spread has no gap to post inside. At 800 KD on a 235-fil stock a
  // 1-fil capture nets -0.06 KD, so the honest answer there is WAIT, not a
  // queued order the screen quietly presents as an opportunity.
  GAP: {
    minGapPct: 40,
    preferInside: true,
    allowQueuedEntry: false,
    // A WIDE SPREAD AND A DEAD TAPE ARE THE SAME FACT. Screening on gap
    // frequency alone surfaced KAMCO at 67.9% gap — 86 trades a day, 8 of them
    // in the first ninety minutes. gapPct is a TIEBREAKER between stocks that
    // already pass liquidity, never a primary rank.
    minTradesPerDay: 150,
    gapLookbackSessions: 10,
  },

  // ---- CR-15. Exit. -----------------------------------------------------
  // A fixed target caps winners and does nothing about losers — the wrong way
  // round. Over 160,633 fills:
  //
  //   trail from +1, exit at peak-1   1.655      <- shipped
  //   trail from +2, exit at peak-1   1.554
  //   trail from +2, exit at peak-2   1.378
  //   fixed 2 fils                    0.977
  //   fixed 1 fil                     0.787
  //
  // Arming at +1 catches more moves; trailing by 1 gives back less on a 1-fil
  // tick grid. This is "let winners run, cut the giveback short" — a TIGHT
  // leash so the giveback stays bounded. Disciplined greed, not aggression.
  //
  // The trail only ever moves UP, and it fires on the FIRST downtick: selling
  // into a rising bid is easy, selling after the peak rolls over means chasing
  // a vanishing bid.
  EXIT: {
    mode: 'trailing',        // fixed | trailing | hybrid
    armAtFils: 1,
    trailFils: 1,
    hardTargetFils: null,    // no cap
    stepDownAfterMin: 45,    // unresolved that long -> drop to the floor, take the smaller win
    // NOT IN THE CR, AND IT MATTERS. armAtFils: 1 can arm below break-even:
    // the CR itself shows a 1-fil capture at 800 KD on a 235-fil stock nets
    // -0.06 KD. Trailing out at +1 there books a loss. With this true the arm
    // level is raised to whichever is greater, +armAtFils or the fils needed to
    // clear the round trip. Set false to follow the CR literally.
    respectCostFloor: true,
  },

  // ---- CR-14. Overnight. ------------------------------------------------
  // A carried position is no longer a spread capture — it is a directional bet.
  // Keep the P&L, quarantine the statistics: mixing it into fill rate and
  // expected fils distorts the measured performance of the passive strategy for
  // reasons that have nothing to do with spread capture.
  CARRY: {
    quarantineStats: true,
    morningAlert: true,
  },

  // ---- AI commentary. ---------------------------------------------------
  // Explains the book and applies the rules. It does NOT forecast — 130 day-runs
  // say direction is unpredictable, and a confident answer there is the most
  // expensive thing it could produce. The ORDER PRICE always comes from
  // budget.js, never from the model: a hallucinated price is a real trade.
  AI: {
    enabled: true,
    model: 'claude-sonnet-4-6',
    maxTokens: 300,
    minSecondsBetweenCalls: 45,
    triggerOn: ['fill', 'spread_change', 'queue_band_change', 'alert', 'user_question'],
  },
};
