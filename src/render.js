/**
 * Canvas rendering. Deliberately plain -- visual polish is out of scope. The
 * only things drawn beyond the bare minimum are the reach affordances while
 * dragging, which are a mechanic (you must be able to see what's in range) and
 * not decoration.
 */

import { T, levelAt, lerp, clamp, clamp01 } from './tuning.js';
import { LIMB_IDS, torsoFrame, anchorOf, specFor, ikJoint, centerOfMass } from './body.js';
import { holdsInRange } from './wall.js';

// HUD buttons sit in a row under the stamina bar, hence the vertical offset.
const HUD_BTN = { w: 44, h: 30, top: 32, gap: 8 };

export function debugButtonRect(view) {
  return {
    x: view.ox + view.playW - HUD_BTN.w - 10 - view.safe.right,
    y: HUD_BTN.top + view.safe.top,
    w: HUD_BTN.w,
    h: HUD_BTN.h,
  };
}

/**
 * Back to the level list. Without it the menu is a one-way door -- you could only
 * reach it again by falling off, which on a phone means reloading the page to
 * give up on a wall.
 */
export function menuButtonRect(view) {
  const b = debugButtonRect(view);
  return { x: b.x - HUD_BTN.w - HUD_BTN.gap, y: b.y, w: HUD_BTN.w, h: b.h };
}

export function hitsRect(r, pt) {
  return pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
}

// --------------------------------------------------------------------------
// menu
// --------------------------------------------------------------------------

const MENU = {
  pad: 18,
  gap: 9,
  header: 104, // title + last-attempt line
  footer: 26,
  rowMin: 50, // never smaller than a comfortable thumb target
  rowMax: 86,
};

/**
 * Row rectangles for the level list, in screen space.
 *
 * Laid out from the view rather than from a fixed design size, because the same
 * menu has to work in a 400pt portrait phone column and in a letterboxed desktop
 * window. Hit testing and drawing both read this, so they can't disagree.
 */
export function menuRects(view) {
  const left = view.ox + view.safe.left + MENU.pad;
  const right = view.ox + view.playW - view.safe.right - MENU.pad;
  const w = right - left;

  const availTop = view.safe.top + MENU.header;
  const availH = view.h - availTop - view.safe.bottom - MENU.footer;
  const n = T.LEVELS.length;
  const rowH = clamp((availH - MENU.gap * (n - 1)) / n, MENU.rowMin, MENU.rowMax);
  const blockH = rowH * n + MENU.gap * (n - 1);
  const top = availTop + Math.max(0, (availH - blockH) / 2);

  return T.LEVELS.map((_, i) => ({
    x: left,
    y: top + i * (rowH + MENU.gap),
    w,
    h: rowH,
  }));
}

/** Index of the level row under `pt`, or null. */
export function menuHit(view, pt) {
  const rects = menuRects(view);
  for (let i = 0; i < rects.length; i++) {
    if (hitsRect(rects[i], pt)) return i;
  }
  return null;
}

/** Green through red across the five levels, so the ladder reads at a glance. */
function levelColor(i) {
  const t = i / Math.max(1, T.LEVELS.length - 1);
  return t < 0.5
    ? mixColor(T.COL.stamHi, T.COL.stamMid, t * 2)
    : mixColor(T.COL.stamMid, T.COL.stamLo, (t - 0.5) * 2);
}

function drawMenu(ctx, game) {
  const { view } = game;
  const left = view.ox + view.safe.left + MENU.pad;
  const cx = view.ox + view.playW / 2;

  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, view.w, view.h);
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, T.COL.bg1);
  g.addColorStop(1, T.COL.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(view.ox, 0, view.playW, view.h);

  // ------------------------------------------------------------------ header
  const top = view.safe.top + MENU.pad;
  ctx.textAlign = 'left';
  ctx.font = '600 26px ui-monospace, monospace';
  ctx.fillStyle = T.COL.text;
  ctx.fillText('CLIMB', left, top + 24);

  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = T.COL.textDim;
  ctx.fillText('pick a wall', left, top + 44);

  // Result of the attempt that sent you back here. This is the only reason the
  // menu doubles as the fall screen -- you land back on the list already knowing
  // why you came off and how high you got.
  if (game.last) {
    const lvl = levelAt(game.last.level);
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = T.COL.stamLo;
    ctx.fillText(game.last.reason, left, top + 70);
    ctx.fillStyle = T.COL.textDim;
    ctx.fillText(
      `on ${game.last.level + 1} ${lvl.name} at ${game.last.height}`,
      left,
      top + 86,
    );
  }

  // ------------------------------------------------------------------- rows
  const rects = menuRects(view);
  rects.forEach((r, i) => {
    const lvl = T.LEVELS[i];
    const picked = game.state === 'building' && game.level === i;
    const col = levelColor(i);

    ctx.fillStyle = picked ? 'rgba(255,209,102,0.18)' : 'rgba(255,255,255,0.05)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 10);
    ctx.fill();
    ctx.strokeStyle = picked ? T.COL.inRange : 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 10);
    ctx.stroke();

    // number, in the level's own colour
    ctx.textAlign = 'center';
    ctx.font = '600 22px ui-monospace, monospace';
    ctx.fillStyle = col;
    ctx.fillText(String(i + 1), r.x + 26, r.y + r.h / 2 + 8);

    ctx.textAlign = 'left';
    ctx.font = '600 14px ui-monospace, monospace';
    ctx.fillStyle = T.COL.text;
    ctx.fillText(lvl.name, r.x + 50, r.y + r.h / 2 - 3);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = T.COL.textDim;
    ctx.fillText(picked ? 'building wall...' : lvl.blurb, r.x + 50, r.y + r.h / 2 + 14);

    // difficulty pips
    const pipR = 3;
    const pipGap = 9;
    const pipX = r.x + r.w - 14 - pipGap * (T.LEVELS.length - 1);
    for (let p = 0; p < T.LEVELS.length; p++) {
      ctx.beginPath();
      ctx.arc(pipX + p * pipGap, r.y + r.h / 2, pipR, 0, Math.PI * 2);
      ctx.fillStyle = p <= i ? col : 'rgba(255,255,255,0.12)';
      ctx.fill();
    }
  });

  // ------------------------------------------------------------------ footer
  ctx.textAlign = 'center';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = T.COL.textDim;
  ctx.fillText(
    'drag hands and feet onto holds  ·  tap a limb to let go',
    cx,
    view.h - view.safe.bottom - 10,
  );
  ctx.textAlign = 'left';
}

export function draw(ctx, game) {
  if (game.state === 'menu' || game.state === 'building') {
    drawMenu(ctx, game);
    return;
  }

  const { view, wall, fig, stam, cam } = game;
  const s = view.scale;
  const w = view.w;
  const h = view.h;
  const ox = view.ox;
  const pw = view.playW;

  const toScreenX = (x) => x * s + ox;
  const toScreenY = (y) => (y - cam.y) * s;

  // ------------------------------------------------------------- background
  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, w, h);

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, T.COL.bg1);
  g.addColorStop(1, T.COL.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(ox, 0, pw, h);

  // everything below is clipped to the play column so the letterbox stays clean
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, 0, pw, h);
  ctx.clip();

  const worldTop = cam.y;
  const worldBottom = cam.y + h / s;

  // height gridlines, every 200 units
  ctx.strokeStyle = T.COL.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = T.COL.grid;
  ctx.font = '10px ui-monospace, monospace';
  const step = 200;
  const first = Math.ceil(worldBottom / step) * step;
  for (let y = first; y >= worldTop - step; y -= step) {
    const sy = Math.round(toScreenY(y)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, sy);
    ctx.lineTo(ox + pw, sy);
    ctx.stroke();
    if (y < 0) ctx.fillText(String(-y), ox + 4, sy - 3);
  }

  // ground
  if (worldBottom > T.GROUND_Y) {
    const gy = toScreenY(T.GROUND_Y);
    ctx.fillStyle = T.COL.ground;
    ctx.fillRect(ox, gy, pw, h - gy);
  }

  // ----------------------------------------------------------------- holds
  const margin = 60;
  const visible = holdsInRange(wall, worldTop - margin, worldBottom + margin);

  // reach affordance for whichever limbs are being dragged
  const dragging = LIMB_IDS.map((id) => fig.limbs[id]).filter((l) => l.drag);
  for (const limb of dragging) {
    const a = anchorOf(fig.hip, fig.chest, limb);
    const spec = specFor(limb.kind);
    ctx.beginPath();
    ctx.arc(toScreenX(a.x), toScreenY(a.y), spec.max * s, 0, Math.PI * 2);
    ctx.fillStyle = T.COL.reach;
    ctx.fill();
  }

  for (const hold of visible) {
    const hx = toScreenX(hold.x);
    const hy = toScreenY(hold.y);
    drawHold(ctx, hold, hx, hy, hold.r * s, s);

    if (game.debug && hold.route) {
      ctx.beginPath();
      ctx.arc(hx, hy, hold.r * s + 3 * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(125,211,160,0.5)';
      ctx.lineWidth = Math.max(1, s);
      ctx.stroke();
    }
  }

  // holds the dragged limb could actually take
  for (const limb of dragging) {
    const a = anchorOf(fig.hip, fig.chest, limb);
    const spec = specFor(limb.kind);
    for (const hold of visible) {
      const d = Math.hypot(hold.x - a.x, hold.y - a.y);
      if (d > spec.max || d < spec.min * 0.55) continue;
      const near = Math.hypot(hold.x - limb.pos.x, hold.y - limb.pos.y) < T.SNAP_RADIUS;
      ctx.beginPath();
      ctx.arc(toScreenX(hold.x), toScreenY(hold.y), (hold.r + (near ? 7 : 4)) * s, 0, Math.PI * 2);
      ctx.strokeStyle = near ? T.COL.inRange : 'rgba(255,209,102,0.45)';
      ctx.lineWidth = (near ? 2.4 : 1.4) * s;
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- figure
  drawFigure(ctx, fig, toScreenX, toScreenY, s, game.debug, h);

  ctx.restore(); // end play-column clip

  // ------------------------------------------------------------------- hud
  drawHud(ctx, game);
}

/**
 * One hold, drawn as its kind (T.HOLD_KINDS). Cosmetic, and the only place that
 * knows about kinds -- the sim sees a quality scalar and nothing else.
 *
 * Every silhouette is built so the SIZE still reads as quality at a glance, because
 * that is what the stamina model actually charges you for. What the shapes add is a
 * second, redundant channel: a jug's deep incut lip, a pocket's hole, a pinch's
 * groove, a sloper's featureless dome (drawn with no lip at all, because that is
 * exactly what makes them hard), a crimp's thin edge. On a phone at arm's length
 * the shape lands before the diameter does.
 */
function drawHold(ctx, hold, x, y, r, s) {
  const base = hold.kind ? hold.kind.col : T.COL.holdGood;
  // good holds sit brighter, so quality still reads within a kind's own band
  const face = mixColor(shade(base, 0.55), base, 0.35 + 0.65 * hold.q);
  const lip = mixColor(face, '#ffffff', 0.35);
  const deep = shade(base, 0.4);
  const edge = Math.max(1, 1.1 * s);
  const name = hold.kind ? hold.kind.name : 'jug';

  ctx.lineWidth = edge;

  if (name === 'crimp') {
    // a thin flat edge: wide, shallow, with a bright top lip and nothing under it
    const w = r * 2.1;
    const h = Math.max(2.5 * s, r * 0.9);
    ctx.fillStyle = face;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, h * 0.45);
    ctx.fill();
    ctx.strokeStyle = lip;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.42, y - h * 0.34);
    ctx.lineTo(x + w * 0.42, y - h * 0.34);
    ctx.stroke();
    return;
  }

  if (name === 'sloper') {
    // a rounded dome, flat-bottomed, no positive edge anywhere on it
    ctx.beginPath();
    ctx.arc(x, y + r * 0.35, r * 1.15, Math.PI, 0);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y - r, 0, y + r * 0.4);
    g.addColorStop(0, lip);
    g.addColorStop(1, deep);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = shade(base, 0.75);
    ctx.stroke();
    return;
  }

  if (name === 'pinch') {
    // two faces you squeeze: a tall block split by a groove
    const w = r * 1.5;
    const h = r * 2.2;
    ctx.fillStyle = face;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, r * 0.45);
    ctx.fill();
    ctx.strokeStyle = deep;
    ctx.lineWidth = Math.max(1.4, r * 0.28);
    ctx.beginPath();
    ctx.moveTo(x, y - h * 0.3);
    ctx.lineTo(x, y + h * 0.3);
    ctx.stroke();
    return;
  }

  if (name === 'pocket') {
    // a round hold with a hole through it -- one or two fingers only
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = lip;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y - r * 0.1, Math.max(1.2 * s, r * 0.42), 0, Math.PI * 2);
    ctx.fillStyle = shade(base, 0.28);
    ctx.fill();
    return;
  }

  // jug: a chunky bucket with a deep incut lip you can wrap a whole hand over.
  // Drawn square-ish on purpose -- a circle is what the pocket is, and two round
  // holds of similar size are exactly the pair that were indistinguishable before.
  const w = r * 2;
  const h = r * 1.7;
  ctx.fillStyle = face;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, r * 0.5);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.32, y - h * 0.18);
  ctx.lineTo(x + w * 0.32, y - h * 0.18);
  ctx.strokeStyle = lip;
  ctx.lineWidth = Math.max(1.6, r * 0.36);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/** Scale a colour toward black; `k` of 1 leaves it alone. */
function shade(col, k) {
  const [r, g, b] = parseCol(col);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

function drawFigure(ctx, fig, sx, sy, s, debug, viewH) {
  const frame = torsoFrame(fig.hip, fig.chest);
  const line = (a, b, width, color) => {
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sy(a.y));
    ctx.lineTo(sx(b.x), sy(b.y));
    ctx.lineWidth = width * s;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  // limbs first so the torso sits on top
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    const a = anchorOf(fig.hip, fig.chest, limb);
    const spec = specFor(limb.kind);
    const joint = ikJoint(a, limb.pos, spec.bone, frame, limb);
    const color = limb.drag
      ? T.COL.dragging
      : limb.hold
        ? T.COL.figure
        : T.COL.figureDim;
    const width = limb.kind === 'hand' ? 4.5 : 5.5;
    line(a, joint, width, color);
    line(joint, limb.pos, width, color);

    // joint
    ctx.beginPath();
    ctx.arc(sx(joint.x), sy(joint.y), 2.6 * s, 0, Math.PI * 2);
    ctx.fillStyle = T.COL.joint;
    ctx.fill();

    // endpoint: filled when it's on a hold
    ctx.beginPath();
    ctx.arc(sx(limb.pos.x), sy(limb.pos.y), (limb.kind === 'hand' ? 5 : 6) * s, 0, Math.PI * 2);
    ctx.fillStyle = limb.drag ? T.COL.dragging : limb.hold ? T.COL.planted : 'rgba(0,0,0,0)';
    ctx.fill();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  // torso, shoulder bar, hip bar
  const shoulderL = { x: fig.chest.x - frame.rx * T.SHOULDER_HALF, y: fig.chest.y - frame.ry * T.SHOULDER_HALF };
  const shoulderR = { x: fig.chest.x + frame.rx * T.SHOULDER_HALF, y: fig.chest.y + frame.ry * T.SHOULDER_HALF };
  const hipL = { x: fig.hip.x - frame.rx * T.HIP_HALF, y: fig.hip.y - frame.ry * T.HIP_HALF };
  const hipR = { x: fig.hip.x + frame.rx * T.HIP_HALF, y: fig.hip.y + frame.ry * T.HIP_HALF };
  line(fig.hip, fig.chest, 8, T.COL.figure);
  line(shoulderL, shoulderR, 5, T.COL.figure);
  line(hipL, hipR, 5, T.COL.figure);

  // head (clear of the shoulder bar, with a neck)
  const head = {
    x: fig.chest.x + frame.ux * T.HEAD_R * 2.1,
    y: fig.chest.y + frame.uy * T.HEAD_R * 2.1,
  };
  line(fig.chest, head, 4, T.COL.figure);
  ctx.beginPath();
  ctx.arc(sx(head.x), sy(head.y), T.HEAD_R * s, 0, Math.PI * 2);
  ctx.fillStyle = T.COL.figure;
  ctx.fill();

  if (debug) {
    const com = centerOfMass(fig);
    ctx.beginPath();
    ctx.arc(sx(com.x), sy(com.y), 4 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#ef6f6c';
    ctx.fill();
    // vertical line through the COM, to eyeball balance against the support span
    ctx.beginPath();
    ctx.moveTo(sx(com.x), 0);
    ctx.lineTo(sx(com.x), viewH);
    ctx.strokeStyle = 'rgba(239,111,108,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawHud(ctx, game) {
  const { view, stam, fig, wall } = game;
  const pad = 12;
  const top = view.safe.top + pad;
  const left = view.ox + view.safe.left + pad;
  const right = view.ox + view.playW - view.safe.right - pad;

  // stamina bar
  const barH = 12;
  const barW = right - left - 56;
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  roundRect(ctx, left, top, barW, barH, barH / 2);
  ctx.fill();

  const v = stam.value;
  const col = v > 0.5 ? T.COL.stamHi : v > 0.22 ? T.COL.stamMid : T.COL.stamLo;
  ctx.fillStyle = col;
  if (v > 0.001) {
    roundRect(ctx, left, top, Math.max(barH, barW * v), barH, barH / 2);
    ctx.fill();
  }

  // rest threshold: where strain stops draining and starts recovering
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = T.COL.textDim;
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(-fig.hip.y)}`, right, top + barH);
  ctx.textAlign = 'left';

  // recovering / draining tick
  const net = stam.smooth - T.REST_STRAIN;
  ctx.fillStyle = net > 0 ? T.COL.stamLo : T.COL.stamHi;
  ctx.fillText(net > 0 ? '▼' : '▲', left + barW + 6, top + barH);

  // hud buttons: back to the level list, and the debug overlay toggle
  const hudBtn = (r, label, on) => {
    ctx.fillStyle = on ? 'rgba(255,209,102,0.22)' : 'rgba(255,255,255,0.07)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    ctx.fillStyle = on ? T.COL.inRange : T.COL.textDim;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 4);
    ctx.textAlign = 'left';
  };
  hudBtn(menuButtonRect(view), 'menu', false);
  hudBtn(debugButtonRect(view), 'dbg', game.debug);

  // which wall you're on
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = T.COL.textDim;
  ctx.fillText(`${wall.level + 1} ${levelAt(wall.level).name}`, left, top + barH + 18);

  if (game.debug) {
    const lines = [
      `strain ${stam.smooth.toFixed(2)}  (rest ${T.REST_STRAIN})`,
      `  hold ${(T.W_HOLD * stam.parts.hold).toFixed(3)}`,
      `  flex ${(T.W_FLEX * stam.parts.flex).toFixed(3)}`,
      `  balnc ${(T.W_BALANCE * stam.parts.balance).toFixed(3)}`,
      `  arms ${(T.W_ARMLOAD * stam.parts.armLoad).toFixed(3)}`,
      `load ${['LH', 'RH', 'LF', 'RF'].map((id) => `${id}:${((stam.load[id] || 0) * 100).toFixed(0)}`).join(' ')}`,
      `planted ${stam.planted}   stamina ${stam.value.toFixed(2)}`,
      `fps ${game.fps.toFixed(0)}  upd ${game.msUpdate.toFixed(2)}ms  ren ${game.msRender.toFixed(2)}ms`,
      `holds ${wall.stats.total} (${wall.stats.route} route)`,
      `level ${wall.level + 1} ${levelAt(wall.level).name}  seed ${wall.seed}`,
    ];
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(left - 4, top + 44, 210, lines.length * 14 + 8);
    ctx.fillStyle = T.COL.text;
    lines.forEach((l, i) => ctx.fillText(l, left, top + 60 + i * 14));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mixColor(a, b, t) {
  const pa = parseCol(a);
  const pb = parseCol(b);
  const k = clamp01(t);
  return `rgb(${Math.round(lerp(pa[0], pb[0], k))},${Math.round(lerp(pa[1], pb[1], k))},${Math.round(lerp(pa[2], pb[2], k))})`;
}

/** Accepts '#rrggbb' or 'rgb(r,g,b)', so mixes and shades can be chained. */
function parseCol(c) {
  if (c[0] === '#') {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return c
    .slice(c.indexOf('(') + 1, -1)
    .split(',')
    .map((v) => parseFloat(v));
}
