/**
 * Game state, camera and the drag interaction.
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
 */

import { T } from './tuning.js';
import { generateWall, holdsNear } from './wall.js';
import {
  createFigure,
  resetToStance,
  stepFigure,
  centerOfMass,
  canReach,
  LIMB_IDS,
} from './body.js';
import { createStamina, updateStamina } from './stamina.js';
import { draw, debugButtonRect } from './render.js';

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
    wall: generateWall(T.SEED),
    fig: null,
    stam: createStamina(),
    cam: { y: 0 },
    accum: 0, // fixed-timestep reservoir
    state: 'climbing', // climbing | falling | fallen
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

    restart() {
      if (game.fig) resetToStance(game.fig, game.wall.start);
      else game.fig = createFigure(game.wall.start);
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
      if (game.state === 'fallen') {
        game.restart();
        return;
      }

      const b = debugButtonRect(game.view);
      if (
        screenPt.x >= b.x &&
        screenPt.x <= b.x + b.w &&
        screenPt.y >= b.y + 22 &&
        screenPt.y <= b.y + 22 + b.h
      ) {
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
        if (canReach(game.fig, limb, hold)) {
          limb.hold = hold;
          break;
        }
      }
    },
  };

  game.fig = createFigure(game.wall.start);
  snapCamera(game);
  return game;
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
    game.fallTimer += dt;
    if (game.fallTimer > T.FALL_LINGER) game.state = 'fallen';
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
