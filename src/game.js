/**
 * Game state, camera and the drag interaction.
 *
 * The state machine is menu -> building -> climbing -> falling -> menu. The menu
 * is what loads first and it's where a fall puts you, so a wall only exists once
 * a level has been picked -- `wall` and `fig` are null in the menu, and both the
 * update and the draw path have to tolerate that.
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
 */

import { T, levelAt } from './tuning.js';
import { generateWall, holdsNear } from './wall.js';
import {
  createFigure,
  resetToStance,
  stepFigure,
  centerOfMass,
  canReach,
  stanceSolvable,
  LIMB_IDS,
} from './body.js';
import { createStamina, updateStamina } from './stamina.js';
import { draw, debugButtonRect, menuButtonRect, menuHit, hitsRect } from './render.js';

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
    wall: null, // no wall until a level is picked
    fig: null,
    stam: createStamina(),
    cam: { y: 0 },
    accum: 0, // fixed-timestep reservoir
    state: 'menu', // menu | building | climbing | falling
    level: 0, // index into T.LEVELS
    buildFrames: 0,
    last: null, // previous attempt, shown on the menu: { level, reason, height }
    fallReason: '',
    fallTimer: 0,
    bestHeight: 0,
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

    showMenu() {
      game.state = 'menu';
      game.pointers.clear();
    },

    /** Pick a level from the menu. The wall is built a frame later; see above. */
    startLevel(index) {
      game.level = Math.max(0, Math.min(T.LEVELS.length - 1, index | 0));
      game.state = 'building';
      game.buildFrames = 0;
      game.pointers.clear();
    },

    /** Retry the current level. No-op from the menu, where there is no level yet. */
    restart() {
      if (!game.wall) return;
      resetToStance(game.fig, game.wall.start);
      game.stam = createStamina();
      game.state = 'climbing';
      game.accum = 0;
      game.fallTimer = 0;
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
        const pick = menuHit(game.view, screenPt);
        if (pick !== null) game.startLevel(pick);
        return;
      }
      // Ignore input while building and while falling. Falling matters: a finger
      // still down as the fall plays out must not have its touch land on the menu
      // that replaces it and start a level the player never chose.
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

      const limb = game.fig.limbs[p.limbId];

      // A tap (touched a limb, never travelled past TAP_SLOP) releases it.
      // Planted limbs limit how far the body can go, so this is how you buy
      // extra reach: take a foot off deliberately, then stretch -- and you now
      // have to hold the position on the contacts you have left.
      if (!p.dragging) {
        limb.hold = null;
        return;
      }

      limb.drag = null;

      // Snap from the solved endpoint, which is already reach-clamped -- an
      // out-of-range hold is simply not offered. Take the nearest hold the limb
      // can actually reach, not just the nearest one: otherwise an unreachable
      // hold sitting slightly closer shadows a good one and the grab fails for
      // no reason the player can see.
      for (const hold of holdsNear(game.wall, limb.pos, T.SNAP_RADIUS)) {
        if (canReach(game.fig, limb, hold) && stanceSolvable(stanceWith(game.fig, limb, hold))) {
          limb.hold = hold;
          break;
        }
      }
    },
  };

  return game;
}

/** Generate the picked level's wall and put the figure on its start stance. */
function buildLevel(game) {
  const level = levelAt(game.level);
  game.wall = generateWall(level.seed, game.level);
  game.fig = createFigure(game.wall.start);
  game.stam = createStamina();
  game.state = 'climbing';
  game.accum = 0;
  game.fallTimer = 0;
  game.bestHeight = 0;
  snapCamera(game);
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

/** Closest limb endpoint to the touch, if one is close enough to mean it. */
function pickLimb(fig, world) {
  let best = null;
  let bestD = T.GRAB_RADIUS;
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
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
  if (game.state === 'menu') return;

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

    const planted = LIMB_IDS.filter((id) => fig.limbs[id].hold).length;
    if (planted === 0) beginFall(game, 'PEELED OFF');
    else if (game.stam.value <= 0) beginFall(game, 'PUMPED OUT');
  } else if (game.state === 'falling') {
    // Watch yourself come off for a beat -- that's the feedback for *why* you
    // fell -- then straight back to the menu, carrying the result with you.
    game.fallTimer += dt;
    if (game.fallTimer > T.FALL_LINGER) {
      game.last = {
        level: game.level,
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

function beginFall(game, reason) {
  game.state = 'falling';
  game.fallReason = reason;
  game.fallTimer = 0;
  game.fig.falling = true; // solver stops constraining; gravity takes over
  for (const id of LIMB_IDS) {
    game.fig.limbs[id].hold = null;
    game.fig.limbs[id].drag = null;
  }
  game.pointers.clear();
}

export function render(game) {
  draw(game.ctx, game);
}
