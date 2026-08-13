/**
 * Home-screen icon generator. Run with `npm run icon`.
 *
 * The icon is the game's own figure, not a drawing of it: the pose below is a
 * four-point stance settled by the real solver (`stepFigure`), and the limbs are
 * jointed by the same `ikJoint` the renderer uses. So if the anatomy changes,
 * re-running this produces an icon that still shows a body the game can make.
 *
 * Holds are drawn as plain discs rather than the five silhouettes in render.js.
 * At 60 CSS px on a home screen a crimp and a pocket are the same three pixels,
 * and duplicating that code into an SVG emitter would be five shapes of upkeep
 * for nothing visible.
 *
 * Writes public/icon.svg (full bleed) + public/icon-maskable.svg (art inside the
 * 80% safe zone Android masks to), then rasterises the PNGs the manifest and
 * `apple-touch-icon` point at. Rasterising needs `rsvg-convert` (brew install
 * librsvg); without it the SVGs are still written and the PNGs are left alone,
 * which is why the PNGs are committed rather than built in CI.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { T } from '../src/tuning.js';
import {
  LIMB_IDS,
  anchorOf,
  createFigure,
  ikJoint,
  specFor,
  stepFigure,
  torsoFrame,
} from '../src/body.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const cx = T.WALL_W / 2;

const kind = (name) => T.HOLD_KINDS.find((k) => k.name === name);

// The pose. Right hand high and out on a long reach, left hand cocked, feet
// spread wide -- the moment the game is about, rather than a figure standing
// still. Positions are world units; y grows downward, so climbing is negative.
const STANCE = {
  RH: { x: cx + 56, y: -246, q: 0.95, r: 13, kind: kind('jug') },
  LH: { x: cx - 58, y: -196, q: 0.8, r: 12, kind: kind('pocket') },
  LF: { x: cx - 42, y: -80, q: 0.9, r: 12, kind: kind('jug') },
  RF: { x: cx + 30, y: -74, q: 0.9, r: 12, kind: kind('jug') },
};

// Holds nobody is on, for texture: an icon of a climber on exactly four holds
// reads as a diagram. Dim, because they are not part of the moment.
const SPARE = [
  { x: cx - 80, y: -136, r: 8, col: kind('pocket').col, dim: 0.34 },
  { x: cx + 80, y: -128, r: 8, col: kind('crimp').col, dim: 0.3 },
  { x: cx - 62, y: -256, r: 7, col: kind('pinch').col, dim: 0.28 },
];

// ---------------------------------------------------------------- colours ---

const parse = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const shade = (c, k) => hex(parse(c).map((v) => v * k));
const mix = (a, b, t) => hex(parse(a).map((v, i) => v + (parse(b)[i] - v) * t));

// ------------------------------------------------------------------- pose ---

/** Settle the stance with the live solver, so the icon shows a body that solves. */
function settle() {
  const fig = createFigure(STANCE);
  for (let i = 0; i < 120 * 4; i++) stepFigure(fig, T.SUB_DT);
  return fig;
}

// -------------------------------------------------------------------- svg ---

const n = (v) => Math.round(v * 100) / 100;
const line = (a, b, w, col) =>
  `<path d="M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}" stroke="${col}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
const disc = (p, r, fill, stroke = null, w = 0) =>
  `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}"${fill ? ` fill="${fill}"` : ' fill="none"'}` +
  (stroke ? ` stroke="${stroke}" stroke-width="${w}"` : '') +
  '/>';

/** A hold: a disc in its kind's colour with a bright lip, as the wall draws it. */
function hold(h, dim = 1) {
  const face = mix(shade(h.col ?? h.kind.col, 0.55), h.col ?? h.kind.col, 0.35 + 0.65 * (h.q ?? 1));
  const lip = mix(face, '#ffffff', 0.35);
  return (
    `<g opacity="${dim}">` +
    disc(h, h.r, face, lip, 1.8) +
    `<path d="M${n(h.x - h.r * 0.5)} ${n(h.y - h.r * 0.42)}A${n(h.r * 0.72)} ${n(h.r * 0.72)} 0 0 1 ${n(h.x + h.r * 0.5)} ${n(h.y - h.r * 0.42)}" stroke="${lip}" stroke-width="${n(h.r * 0.22)}" stroke-linecap="round" fill="none" opacity="0.8"/>` +
    '</g>'
  );
}

/** The figure, drawn limb-then-torso exactly as drawFigure does. */
function figure(fig) {
  const frame = torsoFrame(fig.hip, fig.chest);
  const out = [];

  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    const a = anchorOf(fig.hip, fig.chest, limb);
    const joint = ikJoint(a, limb.pos, specFor(limb.kind).bone, frame, limb);
    // The reaching hand is coloured as if it were being dragged: the icon should
    // show the verb, and yellow-on-a-hold is what mid-move looks like in play.
    const col = id === 'RH' ? T.COL.dragging : T.COL.figure;
    const w = limb.kind === 'hand' ? 4.5 : 5.5;
    out.push(line(a, joint, w, col), line(joint, limb.pos, w, col));
    out.push(disc(joint, 2.6, T.COL.joint));
    out.push(disc(limb.pos, limb.kind === 'hand' ? 5 : 6, id === 'RH' ? T.COL.dragging : T.COL.planted, col, 2));
  }

  const off = (p, half) => [
    { x: p.x - frame.rx * half, y: p.y - frame.ry * half },
    { x: p.x + frame.rx * half, y: p.y + frame.ry * half },
  ];
  const [shL, shR] = off(fig.chest, T.SHOULDER_HALF);
  const [hipL, hipR] = off(fig.hip, T.HIP_HALF);
  const head = {
    x: fig.chest.x + frame.ux * T.HEAD_R * 2.1,
    y: fig.chest.y + frame.uy * T.HEAD_R * 2.1,
  };
  out.push(line(fig.hip, fig.chest, 8, T.COL.figure));
  out.push(line(shL, shR, 5, T.COL.figure));
  out.push(line(hipL, hipR, 5, T.COL.figure));
  out.push(line(fig.chest, head, 4, T.COL.figure));
  out.push(disc(head, T.HEAD_R, T.COL.figure));
  return out.join('');
}

/**
 * Fit the art into a square. `zoom` below 1 pulls it into the maskable safe
 * zone; the background is drawn full bleed either way, so the mask only ever
 * eats empty gradient.
 */
function svg(fig, size, zoom) {
  const pts = [
    ...Object.values(STANCE),
    ...SPARE,
    fig.hip,
    fig.chest,
    { x: fig.chest.x, y: fig.chest.y - T.HEAD_R * 3.2 },
  ];
  const pad = 9;
  const x0 = Math.min(...pts.map((p) => p.x - (p.r ?? 0))) - pad;
  const x1 = Math.max(...pts.map((p) => p.x + (p.r ?? 0))) + pad;
  const y0 = Math.min(...pts.map((p) => p.y - (p.r ?? 0))) - pad;
  const y1 = Math.max(...pts.map((p) => p.y + (p.r ?? 0))) + pad;
  const span = Math.max(x1 - x0, y1 - y0);
  const s = (size / span) * zoom;
  const tx = size / 2 - ((x0 + x1) / 2) * s;
  const ty = size / 2 - ((y0 + y1) / 2) * s;

  const art =
    SPARE.map((h) => hold(h, h.dim)).join('') +
    Object.values(STANCE).map((h) => hold(h)).join('') +
    figure(fig);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="bg" cx="42%" cy="34%" r="78%">
      <stop offset="0" stop-color="${mix(T.COL.bg1, '#ffffff', 0.06)}"/>
      <stop offset="0.62" stop-color="${T.COL.bg1}"/>
      <stop offset="1" stop-color="${T.COL.bg0}"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <g transform="translate(${n(tx)} ${n(ty)}) scale(${n(s)})">${art}</g>
</svg>
`;
}

// ------------------------------------------------------------------- main ---

const fig = settle();
console.log(
  `settled: hip ${fig.hip.x.toFixed(1)},${fig.hip.y.toFixed(1)}  ` +
    `violation ${fig.violation.toFixed(2)}u` +
    (fig.violation > 1 ? '  <-- pose is strained, move the holds' : ''),
);

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon.svg', svg(fig, 512, 1)],
  ['icon-maskable.svg', svg(fig, 512, 0.78)],
];
for (const [name, body] of files) {
  writeFileSync(join(OUT, name), body);
  console.log(`wrote public/${name}`);
}

// The PNGs. iOS only reads apple-touch-icon for the home screen; the rest are
// for the manifest and the browser tab.
const pngs = [
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'favicon-32.png', 32],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];
let rsvg = process.env.RSVG_CONVERT || 'rsvg-convert';
try {
  execFileSync(rsvg, ['--version'], { stdio: 'ignore' });
} catch {
  console.log(`\n${rsvg} not found -- SVGs written, PNGs left as they are.`);
  console.log('Install it (brew install librsvg) or set RSVG_CONVERT=/path/to/rsvg-convert.');
  process.exit(0);
}
for (const [src, dest, size] of pngs) {
  execFileSync(rsvg, ['-w', String(size), '-h', String(size), join(OUT, src), '-o', join(OUT, dest)]);
  console.log(`wrote public/${dest} (${size}px)`);
}
