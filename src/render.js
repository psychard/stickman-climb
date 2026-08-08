/**
 * Canvas rendering. Deliberately plain -- visual polish is out of scope. The
 * only things drawn beyond the bare minimum are the reach affordances while
 * dragging, which are a mechanic (you must be able to see what's in range) and
 * not decoration.
 */

import { T, lerp, clamp01 } from './tuning.js';
import { LIMB_IDS, torsoFrame, anchorOf, specFor, ikJoint, centerOfMass } from './body.js';
import { holdsInRange } from './wall.js';

const DEBUG_BTN = { w: 44, h: 30 };

export function debugButtonRect(view) {
  return {
    x: view.ox + view.playW - DEBUG_BTN.w - 10 - view.safe.right,
    y: 10 + view.safe.top,
    w: DEBUG_BTN.w,
    h: DEBUG_BTN.h,
  };
}

export function draw(ctx, game) {
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
    const r = hold.r * s;

    // quality reads as colour + size: warm blue jug -> small dull crimp
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.fillStyle = mixColor(T.COL.holdBad, T.COL.holdGood, hold.q);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.2 * s);
    ctx.strokeStyle = `rgba(255,255,255,${0.1 + 0.22 * hold.q})`;
    ctx.stroke();

    if (game.debug && hold.route) {
      ctx.beginPath();
      ctx.arc(hx, hy, r + 3 * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(125,211,160,0.5)';
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
    const joint = ikJoint(a, limb.pos, spec.bone, frame, limb.side);
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

  // debug toggle button
  const b = debugButtonRect(view);
  ctx.fillStyle = game.debug ? 'rgba(255,209,102,0.22)' : 'rgba(255,255,255,0.07)';
  roundRect(ctx, b.x, b.y + 22, b.w, b.h, 6);
  ctx.fill();
  ctx.fillStyle = game.debug ? T.COL.inRange : T.COL.textDim;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('dbg', b.x + b.w / 2, b.y + 22 + b.h / 2 + 4);
  ctx.textAlign = 'left';

  if (game.debug) {
    const lines = [
      `strain ${stam.smooth.toFixed(2)}  (rest ${T.REST_STRAIN})`,
      `  hold ${(T.W_HOLD * stam.parts.hold).toFixed(3)}`,
      `  ext  ${(T.W_EXT * stam.parts.ext).toFixed(3)}`,
      `  com  ${(T.W_COM * stam.parts.com).toFixed(3)}`,
      `planted ${stam.planted}   stamina ${stam.value.toFixed(2)}`,
      `fps ${game.fps.toFixed(0)}  upd ${game.msUpdate.toFixed(2)}ms  ren ${game.msRender.toFixed(2)}ms`,
      `holds ${wall.stats.total} (${wall.stats.route} route)`,
      `seed ${wall.seed}`,
    ];
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(left - 4, top + 26, 210, lines.length * 14 + 8);
    ctx.fillStyle = T.COL.text;
    lines.forEach((l, i) => ctx.fillText(l, left, top + 42 + i * 14));
  }

  if (game.state === 'fallen') {
    const cx = view.ox + view.playW / 2;
    ctx.fillStyle = 'rgba(8,10,14,0.72)';
    ctx.fillRect(view.ox, 0, view.playW, view.h);
    ctx.fillStyle = T.COL.text;
    ctx.textAlign = 'center';
    ctx.font = '22px ui-monospace, monospace';
    ctx.fillText(game.fallReason, cx, view.h / 2 - 10);
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillStyle = T.COL.textDim;
    ctx.fillText(`height ${game.bestHeight | 0}`, cx, view.h / 2 + 16);
    ctx.fillText('tap to try again', cx, view.h / 2 + 40);
    ctx.textAlign = 'left';
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
  const pa = parseHex(a);
  const pb = parseHex(b);
  const k = clamp01(t);
  return `rgb(${Math.round(lerp(pa[0], pb[0], k))},${Math.round(lerp(pa[1], pb[1], k))},${Math.round(lerp(pa[2], pb[2], k))})`;
}

function parseHex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
