/**
 * Biophysics measurement harness. Run with `npm run measure`.
 *
 * `verify` and `sim` answer "is it broken?". This answers "what does the model
 * actually do?", and it exists because several tuning decisions in tuning.js
 * cite measured numbers. If you change a strain term, a load rule or a reach
 * constant, re-run this and update the numbers you invalidate.
 *
 *   1. stance table    -- does technique change strain in the right direction?
 *   2. strain spread   -- percentiles over REAL route stances, which is what
 *                         REST_STRAIN is calibrated against. Idealised stances
 *                         in a harness score far lower than anything the
 *                         generator produces, so calibrating on them is wrong.
 *   3. reach envelope  -- reaching in any direction must keep both feet on.
 *   4. release gain    -- how much extra reach taking a foot off actually buys.
 */

import { T } from '../src/tuning.js';
import { generateProblem } from '../src/wall.js';
import { createFigure, stepFigure, anchorOf, LIMB_IDS } from '../src/body.js';
import { createStamina, updateStamina, computeStrain } from '../src/stamina.js';

const cx = T.WALL_W / 2;
const mk = (x, y, q = 1.0) => ({ x, y, q, r: 8, route: true });

function settle(stance, secs = 6, startStamina = 0.5) {
  const fig = createFigure(stance);
  const stam = createStamina();
  stam.value = startStamina;
  for (let i = 0; i < 120 * secs; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
  }
  return { fig, stam, strain: computeStrain(fig), rate: (stam.value - startStamina) / secs };
}

const pct = (v) => (v === undefined ? '  -' : `${(v * 100).toFixed(0).padStart(3)}%`);

function row(label, stance) {
  const { strain: s, rate } = settle(stance);
  console.log(
    label.padEnd(34) +
      `arms ${pct(s.load.LH)}/${pct(s.load.RH)}  feet ${pct(s.load.LF)}/${pct(s.load.RF)}  ` +
      `strain ${s.total.toFixed(2)} ` +
      `(hold ${s.parts.hold.toFixed(2)} flex ${s.parts.flex.toFixed(2)} ` +
      `bal ${s.parts.balance.toFixed(2)} arms ${s.parts.armLoad.toFixed(2)})  ` +
      `${rate >= 0 ? 'RECOVER' : 'DRAIN  '} ${(Math.abs(rate) * 100).toFixed(1)}%/s`,
  );
}

// --------------------------------------------------------------- 1. stances --
console.log(`=== stance table (rest threshold ${T.REST_STRAIN}) ===\n`);
row('feet under hips, on jugs', {
  LH: mk(cx - 26, -232), RH: mk(cx + 26, -232), LF: mk(cx - 24, -55), RF: mk(cx + 24, -55),
});
row('feet off to one side', {
  LH: mk(cx - 26, -232), RH: mk(cx + 26, -232), LF: mk(cx + 40, -60), RF: mk(cx + 70, -55),
});
row('no feet (dead hang on jugs)', { LH: mk(cx - 26, -232), RH: mk(cx + 26, -232) });
row('arms straight', {
  LH: mk(cx - 26, -245), RH: mk(cx + 26, -245), LF: mk(cx - 24, -55), RF: mk(cx + 24, -55),
});
row('arms locked off (bent ~90)', {
  LH: mk(cx - 30, -205), RH: mk(cx + 30, -205), LF: mk(cx - 24, -55), RF: mk(cx + 24, -55),
});
row('legs deeply folded (high step)', {
  LH: mk(cx - 26, -232), RH: mk(cx + 26, -232), LF: mk(cx - 30, -105), RF: mk(cx + 30, -105),
});
row('contacts stacked on one line', {
  LH: mk(cx - 4, -232), RH: mk(cx + 4, -232), LF: mk(cx - 4, -60), RF: mk(cx + 4, -60),
});
for (const q of [0.7, 0.45, 0.25]) {
  row(`hold quality ${q.toFixed(2)}`, {
    LH: mk(cx - 26, -232, q), RH: mk(cx + 26, -232, q),
    LF: mk(cx - 24, -55, q), RF: mk(cx + 24, -55, q),
  });
}

// ---------------------------------------------------- 2. real-stance spread --
console.log('\n=== strain over real route stances (what REST_STRAIN calibrates to) ===\n');
{
  const samples = [];
  const agg = { hold: 0, flex: 0, balance: 0, armLoad: 0 };
  let n = 0;
  // Every problem on the easiest level: these are the stances the rest threshold is
  // calibrated against, and they are now all of one level rather than a slice of an
  // endless wall. See REST_STRAIN.
  for (let index = 0; index < T.PROBLEMS_PER_LEVEL; index++) {
    const wall = generateProblem(0, index);
    const fig = createFigure(wall.start);
    const stam = createStamina();
    const st = (k) => {
      for (let i = 0; i < k; i++) {
        stepFigure(fig, T.SUB_DT);
        updateStamina(stam, fig, T.SUB_DT);
      }
    };
    st(60);
    for (const mv of wall.route.slice(0, 300)) {
      fig.limbs[mv.limb].hold = mv.hold;
      st(30);
      const s = computeStrain(fig);
      samples.push(s.total);
      for (const k in agg) agg[k] += s.parts[k];
      n++;
    }
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.floor(samples.length * p)].toFixed(2);
  console.log(`  ${samples.length} stances:  p10 ${q(0.1)}  p25 ${q(0.25)}  ` +
    `median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}`);
  console.log(`  rest threshold ${T.REST_STRAIN} => the best ` +
    `${(100 * samples.filter((v) => v < T.REST_STRAIN).length / samples.length).toFixed(0)}% of stances recover`);
  console.log('\n  mean weighted contribution by term:');
  console.log(`    hold ${(T.W_HOLD * agg.hold / n).toFixed(3)}   ` +
    `flex ${(T.W_FLEX * agg.flex / n).toFixed(3)}   ` +
    `balance ${(T.W_BALANCE * agg.balance / n).toFixed(3)}   ` +
    `arms ${(T.W_ARMLOAD * agg.armLoad / n).toFixed(3)}`);
  console.log(`  mean bodyweight on the arms: ${(100 * agg.armLoad / n).toFixed(0)}%` +
    '   <- the generator gap: good stances would be far lower');
}

// -------------------------------------------------------- 3. reach envelope --
console.log('\n=== reach envelope (feet must stay on in every case) ===\n');
{
  const wall = generateProblem(0, 0);
  const dirs = { up: [0, -1], diagonal: [0.7, -0.7], sideways: [1, 0] };
  console.log('  direction   reach | body moved | feet on');
  for (const [name, dv] of Object.entries(dirs)) {
    for (const frac of [0.8, 1.0, 1.2, 1.4]) {
      const fig = createFigure(wall.start);
      const stam = createStamina();
      const st = (k) => {
        for (let i = 0; i < k; i++) {
          stepFigure(fig, T.SUB_DT);
          updateStamina(stam, fig, T.SUB_DT);
        }
      };
      st(90);
      const hip0 = { x: fig.hip.x, y: fig.hip.y };
      const limb = fig.limbs.LH;
      const a = anchorOf(fig.hip, fig.chest, limb);
      const from = { x: limb.pos.x, y: limb.pos.y };
      const target = {
        x: a.x + dv[0] * T.ARM.max * frac,
        y: a.y + dv[1] * T.ARM.max * frac,
      };
      limb.hold = null;
      limb.drag = { pointerId: 0, target: { ...from } };
      for (let i = 1; i <= 22; i++) {
        const t = i / 22;
        limb.drag.target.x = from.x + (target.x - from.x) * t;
        limb.drag.target.y = from.y + (target.y - from.y) * t;
        st(1);
      }
      limb.drag = null;
      st(20);
      const feet = LIMB_IDS.filter((id) => fig.limbs[id].kind === 'foot' && fig.limbs[id].hold).length;
      console.log(
        `  ${name.padEnd(10)} ${(frac * 100).toFixed(0).padStart(3)}% | ` +
          `${Math.hypot(fig.hip.x - hip0.x, fig.hip.y - hip0.y).toFixed(1).padStart(6)}u    |   ` +
          `${feet}/2${feet < 2 ? '   <-- FOOT LOST' : ''}`,
      );
    }
  }
}

// ---------------------------------------------------------- 4. release gain --
console.log('\n=== what tapping a limb off buys you ===\n');
{
  const wall = generateProblem(0, 0);
  const reachRight = (release) => {
    const fig = createFigure(wall.start);
    const stam = createStamina();
    const st = (k) => {
      for (let i = 0; i < k; i++) {
        stepFigure(fig, T.SUB_DT);
        updateStamina(stam, fig, T.SUB_DT);
      }
    };
    st(90);
    if (release) {
      fig.limbs[release].hold = null;
      st(60);
    }
    const limb = fig.limbs.RH;
    const a0 = anchorOf(fig.hip, fig.chest, limb);
    const from = { x: limb.pos.x, y: limb.pos.y };
    limb.hold = null;
    limb.drag = { pointerId: 0, target: { ...from } };
    const target = { x: a0.x + 260, y: a0.y };
    for (let i = 1; i <= 60; i++) {
      const t = i / 60;
      limb.drag.target.x = from.x + (target.x - from.x) * t;
      limb.drag.target.y = from.y + (target.y - from.y) * t;
      st(1);
    }
    return limb.pos.x;
  };
  const base = reachRight(null);
  for (const r of [null, 'LF', 'RF', 'LH']) {
    const x = reachRight(r);
    console.log(
      `  released ${(r ?? 'nothing').padEnd(8)} right hand reaches x=${x.toFixed(1)}` +
        (r ? `   (+${(x - base).toFixed(1)}u)` : ''),
    );
  }
}
