/**
 * Game state, camera and the drag interaction.
 *
 * The state machine is menu -> building -> climbing -> (falling -> landed | topped)
 * -> menu, with one edge going backwards: falling -> climbing, which is a catch.
 * The menu is what loads first and it's where both endings put you, so a wall only
 * exists once a problem has been picked -- `wall` and `fig` are null in the menu, and
 * both the update and the draw path have to tolerate that.
 *
 * A problem ends by being TOPPED: both hands on the finish hold, held for
 * TOP_HOLD_TIME. Bouldering's own rule is that you have to control the top rather
 * than slap it, and the delay does a second job -- a wobble that carries a hand
 * through the finish hold on the way somewhere else isn't a send.
 *
 * COMING OFF IS NOT THE END OF THE ATTEMPT -- hitting the ground is. While you are
 * in the air you can still drag a hand onto a hold and latch it (`catchHold`), which
 * puts you straight back into `climbing` hanging off one arm. Only when the figure
 * reaches the floor does the attempt close, and then FALL_LINGER runs and the menu
 * comes back. So `falling` is a playable state and `landed` is the terminal one, and
 * the difference matters to input: a fall wants your finger, a landing does not.
 *
 * `building` exists because generating a wall runs the body solver a few thousand
 * times (~250ms on a laptop, more on a phone). Doing that synchronously inside
 * the tap handler freezes the menu mid-tap, which reads as the tap having been
 * dropped. So the tap only sets the state, and generation waits until the frame
 * that says "building" has actually been presented.
 *
 * Interaction notes that matter for feel:
 *  - Touching a limb doesn't move it. The grab only becomes a drag once the
 *    pointer travels past TAP_SLOP, so a thumb resting on a limb can't start
 *    hauling the body around.
 *  - A touch that never travels is a TAP, and a tap releases the limb. Planted
 *    limbs limit how far the body can reach, so this is the player's lever for
 *    buying extra stretch: drop a trailing foot, then reach.
 *  - Tap-to-release applies to hands too, not just feet. Uniform is more
 *    predictable than special-casing, but it does mean a mistimed tap on a hand
 *    can drop you. Restricting it to feet is a one-line change here if that
 *    turns out to feel unfair.
 *  - Snapping is tested against the limb's *solved* endpoint, which is already
 *    clamped to max reach. So a hold you can't reach simply can't be taken, no
 *    matter how far past it you drag.
 *  - A grab is also refused if the resulting four-hold stance has no solution at
 *    all. Each limb being individually reachable isn't enough: plant four one at
 *    a time, with the body moving in between, and you can assemble a combination
 *    no body can hold, which the solver then renders as a stretched wreck.
 *  - Mid-fall, all of the above still applies except TAP_SLOP: touching a hand
 *    starts steering it immediately. There is no tap-to-release to disambiguate
 *    from (nothing is planted while you're in the air) and no half-second to spend
 *    travelling five units before the rings come up.
 */

import { T } from './tuning.js';
import { today, isDay, shiftDay, monthStart, shiftMonth } from './day.js';
import { generateProblem, holdsNear, holdsInRange, problemKey } from './wall.js';
import {
  createFigure,
  resetToStance,
  stepFigure,
  centerOfMass,
  anchorOf,
  specFor,
  canReach,
  stanceSolvable,
  LIMB_IDS,
} from './body.js';
import { createStamina, updateStamina } from './stamina.js';
import {
  draw,
  debugButtonRect,
  menuButtonRect,
  menuHit,
  calendarRects,
  calendarHit,
  dateChipRect,
  hitsRect,
  updateBandRect,
} from './render.js';
import { applyUpdate, checkForUpdate } from './update.js';

export function createGame(canvas) {
  const game = {
    canvas,
    ctx: canvas.getContext('2d', { alpha: false }),
    view: {
      w: 1,
      h: 1,
      playW: 1, // width of the letterboxed play column
      ox: 0, // its left edge
      scale: 1,
      dpr: 1,
      safe: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    wall: null, // no wall until a problem is picked
    fig: null,
    stam: createStamina(),
    cam: { y: 0 },
    accum: 0, // fixed-timestep reservoir
    // menu | building | climbing | falling | landed | topped. `falling` is playable
    // -- see catchHold -- and `landed` is where an attempt actually ends.
    state: 'menu',
    level: 0, // index into T.LEVELS
    problem: 0, // which of that level's problems
    buildFrames: 0,
    last: null, // previous attempt, shown on the menu
    fallReason: '',
    fallTimer: 0,
    topTimer: 0, // how long both hands have been on the finish hold
    bestHeight: 0,
    // The thirty problems are the day's, and so are the ticks. `days` is the whole
    // history, day -> Set of "level:problem". `day` can be forced from the console
    // (see setDay).
    days: loadHistory(),
    day: 0,
    dayForced: 0,
    dayCheck: 0, // seconds since the clock was last asked, on the menu
    // The menu has two screens -- the problem grid and the calendar of past days --
    // and they are a sub-view rather than a sixth game state. `state` is the climb's
    // lifecycle, and both `update` and `draw` fall through to the physics path on a
    // state they do not recognise, so a 'calendar' state would be two crashes and
    // three audits of places where `state === 'menu'` means "the list is up".
    screen: 'grid',
    // Which day's grid is on screen, as against `day`, which is what day it actually
    // is. The two are the same until the calendar parks the menu on a past day.
    menuDay: 0,
    // The day the problem being built or climbed was generated for. Snapshotted at
    // the tap rather than read in `buildLevel`, because `rollDay` fires from
    // `visibilitychange` in any state and would otherwise hand you a different wall
    // if you backgrounded the phone across midnight between the two.
    problemDay: 0,
    // Which month the calendar is showing, as its first. Only alive while it is up:
    // `showCalendar` reseeds it every time, so nothing else has to remember to move
    // it at midnight.
    calMonth: 0,
    debug: false,
    fps: 60,
    msUpdate: 0,
    msRender: 0,
    pointers: new Map(),

    screenToWorld(p) {
      return {
        x: (p.x - game.view.ox) / game.view.scale,
        y: p.y / game.view.scale + game.cam.y,
      };
    },

    /**
     * Which of today's problems are ticked off. A getter, not a field, deliberately:
     * it is the day's entry in `game.days`, and holding a reference to that Set means
     * anything which replaces it -- clearing the history from the console, a rollover
     * racing a draw -- leaves the menu reading a Set nobody writes to any more, which
     * shows up as a top-out that didn't tick. Derived on read, it cannot go stale.
     */
    get sent() {
      return ticksFor(game, game.day);
    },

    /**
     * A day's ticks, without creating an entry for that day. `ticksFor` makes the Set
     * because something is about to be written to it; this one is for reading, and the
     * menu reads one every frame. Through `ticksFor` that quietly filled `days` with
     * an empty Set for every day ever drawn -- invisible while nothing iterated the
     * map, and a calendar full of days you never played the moment something did.
     */
    ticksOn(day) {
      return game.days.get(day) ?? NO_TICKS;
    },

    /**
     * Can this day still be climbed? Today and yesterday. A set you missed is worth
     * one day's grace; older than that and the daily ritual stops meaning anything,
     * so an old day is a record to read rather than a set to play.
     */
    canPlay(day) {
      return day === game.day || day === shiftDay(game.day, -PLAY_DAYS_BACK);
    },

    /** Can this day's grid be opened at all? Anything except the future. */
    canOpen(day) {
      return isDay(day) && day <= game.day;
    },

    showMenu() {
      // Rolled BEFORE the state flips, which is what lets rollDay tell "the day
      // turned while the list sat open" from "the day turned during the climb whose
      // result I am about to show".
      game.rollDay();
      // Back to the grid you left rather than to today's: the wall carried its own
      // day and its tick was filed there, so that is the grid the result belongs on.
      if (game.problemDay) game.menuDay = game.problemDay;
      game.screen = 'grid';
      game.state = 'menu';
      game.pointers.clear();
      // The menu is the only place an update can be announced, so it's the only
      // place worth asking whether there is one. Throttled inside update.js.
      checkForUpdate();
    },

    /**
     * Move onto today's set if the clock has passed midnight. Returns whether it did.
     *
     * Everything that follows from the date is derived from `game.day` rather than
     * read from the clock at the point of use, so this one call is the whole
     * rollover: `sent` starts reading another day's ticks and the next problem built
     * comes from a different seed. A climb in progress is deliberately left alone --
     * the wall carries its own day (see `wall.day`), so it finishes as part of the
     * set it came from and its tick is filed there.
     */
    rollDay() {
      const day = game.dayForced || today();
      if (day === game.day) return false;
      const was = game.day;
      game.day = day;
      // "You are looking at today" has to keep meaning that, so a menu that was
      // showing today follows the clock. One deliberately parked on a past day from
      // the calendar is a choice, and is left where it was put.
      if (game.menuDay === was) game.menuDay = day;
      // A result banner left from before the rollover names a problem from a set
      // that no longer exists, so it goes. One you have just this second finished
      // does not: it is the report on the attempt you made, whichever set that was
      // on. `menu` here means the day turned with the list already up and nothing
      // newer to say -- see showMenu, which rolls before it flips the state.
      if (game.state === 'menu') game.last = null;
      return true;
    },

    /**
     * Pretend it is another day, for looking at a set without waiting for it.
     * `setDay(0)` hands the decision back to the clock. Ticks are still filed under
     * whatever day is in force, so this writes real history -- it is a debug lever,
     * not a preview.
     */
    setDay(day) {
      game.dayForced = isDay(day) ? day : 0;
      game.rollDay();
      if (game.state !== 'menu') game.showMenu();
      // "It is now this day" means show me it, whatever the menu was parked on.
      game.menuDay = game.day;
      game.screen = 'grid';
      return game.day;
    },

    // ------------------------------------------------------------- the calendar
    /** Into the calendar, on the month of whichever day the grid was showing. */
    showCalendar() {
      game.calMonth = monthStart(game.menuDay);
      game.screen = 'calendar';
    },

    /**
     * One step back. The calendar returns to today's grid, a past day's grid returns
     * to the calendar it was opened from, and today's grid is the root -- so it is at
     * most two presses from anywhere and it terminates. Returns whether it moved.
     */
    menuBack() {
      if (game.screen === 'calendar') {
        game.menuDay = game.day;
        game.screen = 'grid';
        return true;
      }
      if (game.menuDay !== game.day) {
        game.showCalendar();
        return true;
      }
      return false;
    },

    /** Show a day's grid. Refuses the future, which has neither record nor walls. */
    openDay(day) {
      if (!game.canOpen(day)) return false;
      game.menuDay = day;
      game.screen = 'grid';
      return true;
    },

    /**
     * The oldest month the calendar pages back to: the month of the oldest day
     * anything was topped on, or of yesterday, whichever is earlier. Yesterday is in
     * there because it is playable and can fall in the previous month -- on the 1st,
     * paging back is the only way to reach it.
     */
    earliestMonth() {
      let oldest = monthStart(shiftDay(game.day, -PLAY_DAYS_BACK));
      for (const [day, ticks] of game.days) {
        if (ticks.size && day < oldest) oldest = monthStart(day);
      }
      return oldest;
    },

    /** Is there a month that way? Forward stops at this one, back at earliestMonth. */
    canPage(n) {
      const to = shiftMonth(game.calMonth, n);
      return to >= game.earliestMonth() && to <= monthStart(game.day);
    },

    pageMonth(n) {
      if (!game.canPage(n)) return false;
      game.calMonth = shiftMonth(game.calMonth, n);
      return true;
    },

    // ------------------------------------------------------------- starting one
    /**
     * Pick a problem from the menu. The wall is built a frame later; see above.
     *
     * The day is a parameter defaulting to the one being browsed, and the check on it
     * is the *only* gate on what is playable: the grid tap, the number keys, the
     * console and the tuner's rebuild all come through here. It returns whether it
     * took, so a caller that isn't a tap can tell.
     */
    startProblem(level, index, day = game.menuDay) {
      if (!game.canPlay(day)) return false;
      game.problemDay = day;
      game.level = clampIndex(level, T.LEVELS.length);
      game.problem = clampIndex(index, T.PROBLEMS_PER_LEVEL);
      game.screen = 'grid';
      game.state = 'building';
      game.buildFrames = 0;
      game.pointers.clear();
      return true;
    },

    /** Kept for the number-key shortcut: the first problem of a level. */
    startLevel(index) {
      return game.startProblem(index, 0);
    },

    /** Retry the current problem. No-op from the menu, where there is no wall yet. */
    restart() {
      if (!game.wall) return;
      resetToStance(game.fig, game.wall.start);
      game.stam = createStamina();
      game.state = 'climbing';
      game.accum = 0;
      game.fallTimer = 0;
      game.topTimer = 0;
      game.bestHeight = 0;
      game.pointers.clear();
      snapCamera(game);
    },

    toggleDebug() {
      game.debug = !game.debug;
    },

    // ---------------------------------------------------------------- input
    pointerDown(id, screenPt) {
      if (game.state === 'menu') {
        // One rect, three jobs: into the calendar from today's grid, back to it from
        // a day opened there, back out of it. It is tested before anything else on
        // either screen, which is what keeps it from being shadowed.
        if (hitsRect(dateChipRect(game.view).tap, screenPt)) {
          if (game.screen === 'calendar') game.menuBack();
          else game.showCalendar();
          return;
        }

        if (game.screen === 'calendar') {
          const cal = calendarRects(game.view, game.calMonth);
          // Arrows first: they sit above the grid, but a dead one must not swallow
          // a tap either, so `canPage` gates the hit exactly as it dims the glyph.
          for (const [n, rect] of [
            [-1, cal.prev],
            [1, cal.next],
          ]) {
            if (hitsRect(rect, screenPt)) {
              game.pageMonth(n);
              return;
            }
          }
          const day = calendarHit(game.view, game.calMonth, screenPt);
          if (day !== null) game.openDay(day);
          return;
        }

        // The update band sits below the grid and only exists while a new build
        // is waiting, so it can't shadow a tile. Grid only: it isn't drawn on the
        // calendar, and a hit test for something invisible is how a browse turns
        // into a page reload.
        const band = updateBandRect(game.view);
        if (band && hitsRect(band, screenPt)) {
          applyUpdate();
          return;
        }
        const pick = menuHit(game.view, screenPt);
        if (pick) game.startProblem(pick.level, pick.index);
        return;
      }
      // A fall is playable, so it takes input -- but only ever a hand onto a hold.
      // No TAP_SLOP here: nothing is planted, so there is no tap-to-release for a
      // travel threshold to disambiguate from, and half a second is not long enough
      // to spend five units of it proving you meant it.
      if (game.state === 'falling') {
        const world = game.screenToWorld(screenPt);
        // No GRAB_RADIUS either: any touch takes a hand, the nearest one. Hunting
        // for a limb is the one thing half a second cannot afford, and the verb
        // survives it -- the hand reaches toward wherever your finger is, so
        // touching the hold you want IS the gesture.
        const limb = pickLimb(game.fig, world, { kind: 'hand', radius: Infinity });
        if (!limb) return; // both hands already have a finger on them
        limb.drag = { pointerId: id, target: { x: world.x, y: world.y } };
        game.pointers.set(id, { down: world, limbId: limb.id, dragging: true });
        return;
      }
      // Ignore input while building, while on the floor, and while topping out. The
      // floor matters: a finger still down as the result plays out must not have its
      // touch land on the menu that replaces it and start a level nobody chose.
      if (game.state !== 'climbing') return;

      if (hitsRect(menuButtonRect(game.view), screenPt)) {
        game.showMenu();
        return;
      }
      if (hitsRect(debugButtonRect(game.view), screenPt)) {
        game.toggleDebug();
        return;
      }

      const world = game.screenToWorld(screenPt);
      const limb = pickLimb(game.fig, world);
      game.pointers.set(id, { down: world, limbId: limb ? limb.id : null, dragging: false });
    },

    pointerMove(id, screenPt) {
      const p = game.pointers.get(id);
      if (!p || !p.limbId) return;
      const world = game.screenToWorld(screenPt);
      const limb = game.fig.limbs[p.limbId];

      if (!p.dragging) {
        if (Math.hypot(world.x - p.down.x, world.y - p.down.y) < T.TAP_SLOP) return;
        p.dragging = true;
        limb.hold = null;
        limb.drag = { pointerId: id, target: { x: world.x, y: world.y } };
        return;
      }
      limb.drag.target.x = world.x;
      limb.drag.target.y = world.y;
    },

    pointerUp(id) {
      const p = game.pointers.get(id);
      game.pointers.delete(id);
      if (!p || !p.limbId) return;
      // The state can have moved on under a finger that was already down -- you
      // land, or you top out mid-drag -- and neither of those wants a hold planted.
      if (game.state !== 'climbing' && game.state !== 'falling') return;

      const limb = game.fig.limbs[p.limbId];

      // A tap (touched a limb, never travelled past TAP_SLOP) releases it.
      // Planted limbs limit how far the body can go, so this is how you buy
      // extra reach: take a foot off deliberately, then stretch -- and you now
      // have to hold the position on the contacts you have left.
      if (!p.dragging) {
        limb.hold = null;
        return;
      }

      // Take exactly the hold the ring said you would. `refreshTargets` is what
      // the renderer drew from on the last frame and nothing has moved the body
      // since -- update runs before render, and a pointer event lands between
      // frames -- so recomputing here returns the same answer it drew, and the
      // memo makes that nearly free. Calling it rather than reading the cached
      // `take` also covers the flick that goes down, past TAP_SLOP and up inside
      // a single frame, where no update has run to fill it in yet.
      const { take } = refreshTargets(game, limb);
      limb.drag = null;
      if (!take) return;
      if (game.state === 'falling') catchHold(game, limb, take);
      else limb.hold = take;
    },
  };

  game.rollDay();
  return game;
}

/** Generate the picked problem and put the figure on its start stance. */
function buildLevel(game) {
  game.wall = generateProblem(game.level, game.problem, game.problemDay);
  game.fig = createFigure(game.wall.start);
  game.stam = createStamina();
  game.state = 'climbing';
  game.accum = 0;
  game.fallTimer = 0;
  game.topTimer = 0;
  game.bestHeight = 0;
  snapCamera(game);
}

const clampIndex = (v, n) => Math.max(0, Math.min(n - 1, v | 0));

/**
 * How far back a set stays playable. One day: missing a set is worth a day's grace,
 * and beyond that the daily ritual stops meaning anything. A navigation rule rather
 * than a tuning knob, so it lives here and not in `tuning.js`.
 */
const PLAY_DAYS_BACK = 1;

/** Shared, and never written to. See `ticksOn`. */
const NO_TICKS = new Set();

/**
 * Which problems were topped, by day, from localStorage.
 *
 * The ticks reset every midnight but the record of them does not: `{ "20260814":
 * ["0:0", "2:5"], ... }`, which with the day-seeded generator is enough to rebuild
 * exactly which walls those were. That is the shape a streak counter, a score
 * accumulator or a calendar wants, so those can be added later without a migration.
 *
 * Ticking a problem off is the only state in the game that outlives a page load, and
 * it is worth exactly nothing if it throws: Safari in private mode denies access to
 * localStorage entirely, and a game that refuses to start because it can't remember
 * your ticks would be a poor trade. So every access is wrapped and failure just means
 * the ticks don't persist. Anything malformed in there is dropped rather than trusted
 * -- it is a public key in a store the player can edit.
 */
function loadHistory() {
  const out = new Map();
  try {
    // The old key held one flat list of ticks against the thirty problems that used
    // to be fixed forever. Those walls cannot be generated any more, so the list
    // means nothing and is dropped rather than migrated onto days it never had.
    localStorage.removeItem(LEGACY_KEY);

    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    for (const [key, list] of Object.entries(raw)) {
      const day = Number(key);
      if (!isDay(day) || !Array.isArray(list)) continue;
      out.set(day, new Set(list.filter((k) => typeof k === 'string')));
    }
  } catch {
    /* private mode, or corrupt: this session simply starts with no history */
  }
  return out;
}

/** The tick set for a day, created on demand. */
function ticksFor(game, day) {
  let set = game.days.get(day);
  if (!set) game.days.set(day, (set = new Set()));
  return set;
}

function saveHistory(game) {
  try {
    // Newest first, capped: a phone should not accumulate an unbounded record of
    // every day it was ever opened. Empty days aren't worth a line.
    const days = [...game.days.keys()].sort((a, b) => b - a).slice(0, T.HISTORY_DAYS);
    const out = {};
    for (const day of days) {
      const set = game.days.get(day);
      if (set.size) out[day] = [...set];
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
  } catch {
    /* private mode, or a full quota: the ticks are simply not remembered */
  }
}

const HISTORY_KEY = 'climb.days.v1';
const LEGACY_KEY = 'climb.sent.v1';

/**
 * Is the figure still on the wall in a way a body could manage?
 *
 * The design assumed releasing a limb was always safe, on the grounds that it only
 * removes constraints. That is false once both hands are off: what's left is a body
 * hanging from two feet, and POSE.FOOT_RISE forbids a foot above the hip outright,
 * so no body position satisfies the stance. The solver returns its best answer, the
 * best answer is a leg folded up past the head, and it reads as the game breaking --
 * when what actually happened is that the player let go of the wall.
 *
 * So: with no hand planted, the feet have to be able to hold you on their own. They
 * usually can -- standing on a ledge is exactly this and solves cleanly -- and when
 * they can't, you come off. `stanceSolvable` is the same gate planting already uses,
 * and this only runs in the rare no-hands case, so it costs nothing in normal play.
 */
function supported(fig) {
  const planted = LIMB_IDS.map((id) => fig.limbs[id]).filter((l) => l.hold);
  if (!planted.length) return true; // nothing on the wall at all is the PEELED OFF rule
  if (planted.some((l) => l.kind === 'hand')) return true;
  const pts = {};
  for (const l of planted) pts[l.id] = l.hold;
  return stanceSolvable(pts);
}

/** The four-hold stance that would result from `limb` taking `hold`. */
function stanceWith(fig, limb, hold) {
  const pts = {};
  for (const id of LIMB_IDS) {
    const other = fig.limbs[id];
    if (other !== limb && other.hold) pts[id] = other.hold;
  }
  pts[limb.id] = hold;
  return pts;
}

/**
 * Which holds this dragged limb could actually take, and which one it would get.
 *
 * The rings are the only thing telling the player what a drag will do, so they are
 * not allowed a cheaper opinion than the release they predict. **This is the only
 * place either question is answered** -- the renderer draws what is on the drag and
 * `pointerUp` takes what is on the drag -- for the same reason `menuRects` is
 * shared: two copies of a rule disagree eventually.
 *
 * They did. The renderer used to test a raw distance band off the anchor, with no
 * pose cone and no stance check, and over 8500 frames of route drags it disagreed
 * with the grab on 40% of the rings it drew and 14% of the bright ones. That is the
 * bug where a hold is circled, you let go, and nothing happens.
 *
 * `take` is the single hold a release would land on -- nearest first within
 * `SNAP_RADIUS`, which is the order `holdsNear` returns. It is drawn differently
 * from the rest rather than every close hold lighting up together, because only one
 * of them was ever going to be taken and the bright ring is the one the player
 * actually reads.
 *
 * **What makes the honest version affordable is that `stanceSolvable` does not
 * depend on the body at all.** `solveStatic` seeds from the hold centroids, not
 * from the live figure, so its answer for "this limb on this hold, the others
 * where they are" stays good until one of the OTHER limbs changes what it is on
 * -- which during a drag is never, unless a second finger is also working. So it
 * is memoised against that signature and each hold is solved once per drag
 * instead of sixty times a second. Uncached it costs 0.78ms a frame, which does
 * not fit in a 16.7ms budget alongside the solver.
 *
 * **`canReach` is the opposite and is deliberately not cached.** Its anchor hangs
 * off the chest or hip and its cone lives in the torso frame, so both translate
 * and rotate as the body moves under the drag -- which is why rings appear and
 * disappear while you stretch, and why they have to. Freezing them at drag start
 * would put the ring back to lying the moment the torso turned, which is the bug
 * this function exists to fix. Measured over the route drags of all thirty
 * problems: `canReach` changes its mind about a hold 937 times, `stanceSolvable`
 * zero -- so the live half is the whole of the churn, and the cached half is
 * genuinely invariant rather than merely assumed to be.
 *
 * Measured over the route drags of all thirty problems: 94% of frames do no
 * solves at all and cost 8.5us. The rest is paid on the frame a drag starts,
 * where 4.3 holds are in range on average (max 11) at ~105us each -- 448us
 * typical, 1.2ms worst. That spike is the price of the ring being true on the
 * first frame it appears, and it fits.
 *
 * Scanned over the reach band rather than the visible one: nothing further than
 * `spec.max` from the anchor can pass `canReach`, so that band is both tight and
 * complete, and unlike the visible range it doesn't change with the camera.
 */
function refreshTargets(game, limb) {
  const drag = limb.drag;
  const { fig, wall } = game;

  // The memo is only valid while the rest of the stance is unchanged.
  const sig = LIMB_IDS.map((id) => (id === limb.id ? null : fig.limbs[id].hold));
  if (!drag.solved || sig.some((hold, i) => hold !== drag.sig[i])) {
    drag.solved = new Map();
    drag.sig = sig;
  }

  const a = anchorOf(fig.hip, fig.chest, limb);
  const max = specFor(limb.kind).max;
  const reach = new Set();
  for (const hold of holdsInRange(wall, a.y - max, a.y + max)) {
    if (!canReach(fig, limb, hold)) continue;
    let ok = drag.solved.get(hold);
    if (ok === undefined) drag.solved.set(hold, (ok = stanceSolvable(stanceWith(fig, limb, hold))));
    if (ok) reach.add(hold);
  }

  let take = null;
  for (const hold of holdsNear(wall, limb.pos, T.SNAP_RADIUS)) {
    if (reach.has(hold)) {
      take = hold;
      break;
    }
  }

  drag.reach = reach;
  drag.take = take;
  return drag;
}

/**
 * Closest limb endpoint to the touch, if one is close enough to mean it.
 *
 * `kind` and `radius` are both for the mid-fall catch, and both narrow or widen for
 * the same reason -- that a fall is about half a second long.
 *
 * Hands only: `supported()` wants a hand on the wall, so a foot latched in mid-air
 * buys exactly the time it takes TOPPLE_BUDGET to run out and then drops you again.
 * Offering it would be offering a move that cannot work.
 *
 * And no distance limit, where climbing has GRAB_RADIUS. On the wall that radius is
 * what stops a stray touch hauling a limb you didn't mean; mid-air there is no other
 * thing a touch could mean, and making the player find a hand first is how the window
 * gets spent.
 */
function pickLimb(fig, world, { kind = null, radius = T.GRAB_RADIUS } = {}) {
  let best = null;
  let bestD = radius;
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    if (kind && limb.kind !== kind) continue;
    if (limb.drag) continue; // already owned by another pointer
    const d = Math.hypot(limb.pos.x - world.x, limb.pos.y - world.y);
    if (d < bestD) {
      bestD = d;
      best = limb;
    }
  }
  return best;
}

function cameraTarget(game) {
  const com = centerOfMass(game.fig);
  const target = com.y - (T.CAM_ANCHOR * game.view.h) / game.view.scale;
  // never scroll below the ground
  return Math.min(target, 60 - game.view.h / game.view.scale);
}

function snapCamera(game) {
  game.cam.y = cameraTarget(game);
}

export function update(game, dt) {
  if (game.state === 'menu') {
    // Someone can sit on this screen for hours, and the tiles have to be honest
    // about whose ticks they are showing. Asking the clock once a second is enough
    // to turn the set over within a second of midnight and costs nothing.
    game.dayCheck += dt;
    if (game.dayCheck >= 1) {
      game.dayCheck = 0;
      game.rollDay();
    }
    return;
  }

  // Wait for the "building" frame to actually reach the screen before spending a
  // quarter of a second in the generator, or the tap looks like it was dropped.
  if (game.state === 'building') {
    if (game.buildFrames++ > 0) buildLevel(game);
    return;
  }

  const { fig } = game;

  // Fixed-step physics so the solver behaves identically at 60 and 120Hz.
  // The leftover time MUST carry to the next frame rather than being run as a
  // short final substep: the solver derives velocity as delta/dt, so a sliver
  // of a timestep turns a rounding-sized position delta into a huge impulse and
  // the figure vibrates. Whole steps only.
  game.accum = Math.min(game.accum + dt, T.SUB_DT * T.MAX_SUBSTEPS);
  while (game.accum >= T.SUB_DT) {
    stepFigure(fig, T.SUB_DT);
    game.accum -= T.SUB_DT;
  }

  if (game.state === 'climbing') {
    updateStamina(game.stam, fig, dt);
    game.bestHeight = Math.max(game.bestHeight, -fig.hip.y);

    // Work out what each drag could take before anything draws it. Doing this here
    // rather than in the renderer is what lets the ring and the grab share one
    // answer: update runs first, so what was last drawn is what pointerUp sees.
    for (const id of LIMB_IDS) {
      if (fig.limbs[id].drag) refreshTargets(game, fig.limbs[id]);
    }

    // Both hands on the finish hold, controlled rather than slapped.
    game.topTimer = matchingTop(game) ? game.topTimer + dt : 0;

    const planted = LIMB_IDS.filter((id) => fig.limbs[id].hold).length;
    if (game.topTimer >= T.TOP_HOLD_TIME) topOut(game);
    else if (planted === 0) beginFall(game, 'PEELED OFF');
    else if (game.stam.value <= 0) beginFall(game, 'PUMPED OUT');
    else if (!supported(fig)) beginFall(game, 'CAME OFF');
    // Standing on your feet with no hand on the wall, and your weight has been off
    // the far side of them for longer than you could hold it. `supported` above is
    // the kinematic half of the same question -- can the legs reach at all -- and
    // it passes cleanly here, because leaning out past your feet is a position a
    // body can get into. It just isn't one it can stay in. See T.TOPPLE_BUDGET.
    else if (fig.topple > T.TOPPLE_BUDGET) beginFall(game, 'OFF BALANCE');
    // Backstop for anything the rules above don't see: a stance the solver simply
    // cannot answer, held for long enough that it isn't a wedge being fixed.
    else if (fig.lostFor > T.FALL_VIOLATION_TIME) beginFall(game, 'CAME OFF');
  } else if (game.state === 'topped') {
    game.fallTimer += dt;
    if (game.fallTimer > T.TOP_LINGER) game.showMenu();
  } else if (game.state === 'falling') {
    // You are in the air and it is still your move: a hand dragged onto a hold
    // catches you. So the rings have to be live here for exactly the reason they
    // are live while climbing -- they are the only thing saying what a release will
    // do, and mid-fall that is the difference between the attempt continuing and
    // not. Same function, same answer, nothing cheaper.
    for (const id of LIMB_IDS) {
      if (fig.limbs[id].drag) refreshTargets(game, fig.limbs[id]);
    }
    // `grounded` is set by stepFigure, which has already run this frame.
    if (fig.grounded) touchDown(game);
  } else if (game.state === 'landed') {
    // On the floor: this is where an attempt actually ends. A beat to register it,
    // then back to the menu carrying the result.
    game.fallTimer += dt;
    if (game.fallTimer > T.FALL_LINGER) {
      game.last = {
        day: game.wall.day,
        level: game.level,
        problem: game.problem,
        reason: game.fallReason,
        height: Math.round(game.bestHeight),
      };
      game.showMenu();
    }
  }

  // camera follow
  const target = cameraTarget(game);
  const k = 1 - Math.exp(-T.CAM_LERP * dt);
  game.cam.y += (target - game.cam.y) * k;
}

/** Are both hands on the finish hold right now? */
function matchingTop(game) {
  const top = game.wall.finish;
  if (!top) return false;
  return game.fig.limbs.LH.hold === top && game.fig.limbs.RH.hold === top;
}

/** Topped it: tick the problem off, and let the player see it before the menu. */
function topOut(game) {
  game.state = 'topped';
  game.fallTimer = 0;
  // A send under live tuning overrides is not a send. `game.tuned` is set only by
  // the dev-only rig in src/tune.js, so in a built game this is always false.
  //
  // This deliberately goes the other way from setDay, which *does* write real
  // history -- and the difference is whether the wall can be named. A setDay wall
  // is reproducible from day + level + index, so its tick means something. A
  // problem topped under a tripled RECOVER_RATE is reproducible from nothing
  // stored, so the tick would be a claim about the real game that isn't true --
  // in the one key that outlives a page load, and that a streak or a calendar
  // will be built from.
  const sent = !game.tuned?.on;
  if (sent) {
    // Filed against the wall's own day, not today's. They differ only when midnight
    // passed mid-problem, and then the wall is the one that's right: this was a
    // problem from yesterday's set and that is where it belongs in the record.
    ticksFor(game, game.wall.day).add(problemKey(game.level, game.problem));
    saveHistory(game);
  }
  game.last = {
    day: game.wall.day,
    level: game.level,
    problem: game.problem,
    reason: 'TOPPED',
    height: Math.round(game.bestHeight),
    sent,
  };
  game.pointers.clear();
  for (const id of LIMB_IDS) game.fig.limbs[id].drag = null;
}

/**
 * Come off the wall. This ends the STANCE, not the attempt -- see catchHold.
 *
 * Fingers already down are deliberately NOT cleared, and this is the fiddliest part
 * of the whole feature. The fall is about half a second off the top of a problem and
 * it is now the most time-critical thing in the game, so making the player lift a
 * finger and put it back down before they may reach for anything would spend most of
 * the window on ceremony. So each pointer is carried across, converted to what it
 * would mean in the air:
 *
 *  - a HAND mid-drag keeps its drag, and its finger keeps steering it;
 *  - a HAND merely touched (never past TAP_SLOP) is promoted to a drag where it sits,
 *    because mid-air a touch on a hand has no other meaning -- the same reason
 *    TAP_SLOP is off in `pointerDown`;
 *  - a FOOT loses its drag, since feet don't catch (see pickLimb) and a live drag
 *    would ring holds it cannot take. Its pointer is neutralised rather than deleted,
 *    so lifting that finger does nothing instead of doing something wrong.
 */
function beginFall(game, reason) {
  const { fig } = game;
  game.state = 'falling';
  game.fallReason = reason;
  game.fallTimer = 0;
  fig.falling = true; // solver stops constraining; gravity takes over
  fig.grounded = false;
  // The base-of-support bar is drawn from this and the falling branch of stepFigure
  // never rewrites it, so a stale one would hang in the air under a falling figure.
  fig.balance = null;
  for (const id of LIMB_IDS) fig.limbs[id].hold = null;

  for (const [id, p] of game.pointers) {
    const limb = p.limbId ? fig.limbs[p.limbId] : null;
    if (!limb) continue;
    if (limb.kind === 'foot') {
      limb.drag = null;
      p.limbId = null;
    } else if (!p.dragging) {
      p.dragging = true;
      limb.drag = { pointerId: id, target: { x: p.down.x, y: p.down.y } };
    }
  }
}

/** Hit the floor. The attempt is over here, and not a moment before. */
function touchDown(game) {
  game.state = 'landed';
  game.fallTimer = 0;
  for (const id of LIMB_IDS) game.fig.limbs[id].drag = null;
  game.pointers.clear();
}

/**
 * Latch a hold in mid-air, and carry on climbing.
 *
 * This is the whole point of the fall being playable: coming off is a mistake to
 * recover from rather than a verdict. The gate is the ordinary one -- `refreshTargets`
 * decided this hold, which means `canReach` and `stanceSolvable` both said yes from
 * where the body is at the instant you let go -- so a catch is not a special grab
 * with looser rules. It just happens on a body that is moving.
 *
 * Velocity is deliberately NOT zeroed. It survives exactly one substep before the
 * reach clamp hauls the body inside the arm and the momentum is re-derived from
 * where the body actually ended up, so it is self-limiting, and that one substep is
 * the jerk of catching something.
 *
 * Stamina is the part that needs a decision. You are almost always here because you
 * were empty, and a catch that hands back nothing is a half-second reprieve followed
 * by an identical fall -- PUMPED OUT fires again on the very next frame. So a catch
 * is worth CATCH_STAMINA, if you had less. That is not a free reset: you land on one
 * arm with no feet, which is about the most expensive stance on the wall, so the
 * sliver drains unless you get your feet back on quickly. And a fall costs the height
 * you fell, which no amount of catching gives back.
 */
function catchHold(game, limb, hold) {
  const { fig } = game;
  limb.hold = hold;
  limb.drag = null;
  fig.falling = false;
  fig.grounded = false;
  // Every clock the fall's own endings run on is stale now. `lostFor` especially:
  // if the reason was CAME OFF then it is sitting above FALL_VIOLATION_TIME, and
  // left alone it would drop you again the first frame the new stance is anything
  // other than perfect.
  fig.lostFor = 0;
  fig.violation = 0;
  fig.topple = 0;
  fig.wedgeSpent = 0;
  game.state = 'climbing';
  game.fallTimer = 0;
  game.stam.value = Math.max(game.stam.value, T.CATCH_STAMINA);
}

export function render(game) {
  draw(game.ctx, game);
}
