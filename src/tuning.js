/**
 * EVERY tuning knob lives here. If you are adjusting how the game feels, this
 * is the only file you should need to open.
 *
 * World units: the wall is WALL_W units wide and is scaled to fill the screen
 * width, so 1 unit ~= 1 css px on a 400pt-wide phone. y grows DOWNWARD (canvas
 * convention); the ground is y = 0 and climbing goes negative. "Height" shown
 * to the player is -y.
 */

export const T = {
  // ---------------------------------------------------------------- world ---
  WALL_W: 400, // wall width in world units; maps to the full play column width
  // On a phone the play column is the whole screen. On a desktop window we
  // letterbox to roughly phone width instead of stretching, so development on a
  // laptop shows the same framing and reach-vs-screen ratio as the real target.
  MAX_PLAY_W: 460,
  GROUND_Y: 0,
  GRAVITY: 1500, // world units / s^2 -- only used once you're actually falling

  // ---------------------------------------------------------------- figure ---
  TORSO_LEN: 62, // hip -> chest (shoulder centre)
  SHOULDER_HALF: 17, // half shoulder width
  HIP_HALF: 12, // half hip width
  HEAD_R: 11,

  // Limb reach envelopes. max is the hard wall; pref is the relaxed length the
  // limb sits at unloaded; min stops the body collapsing into the hold.
  ARM: { max: 68, pref: 50, min: 22, bone: 34 },
  LEG: { max: 80, pref: 60, min: 26, bone: 40 },

  // Anatomical pose limits, expressed in the torso frame: `up` runs hip->chest,
  // `out` is sideways on the limb's own side. Without these a limb is legal
  // anywhere on a ring around its socket, so you can plant a foot above your own
  // chest. Values are world units of the socket->endpoint offset.
  POSE: {
    // A foot can come up to roughly hip level on a high step, no further.
    FOOT_RISE: 14,
    // ...and can flag across the body, but not wrap around it.
    FOOT_CROSS: 28,
    // Hands work from overhead down to about hip level (pressing out a mantel).
    HAND_DROP: 70,
    // Cross-body reaching is real, but bounded.
    HAND_CROSS: 34,
  },
  POSE_STIFF: 0.7, // how hard the solver pushes a limb back inside its cone

  // Nothing peels a limb off a hold automatically. A planted limb constrains how
  // far the body can travel, so over-reaching is simply prevented rather than
  // punished -- the player taps a limb to release it when they want the extra
  // reach, and then has to hold the position on what's left.

  // ---------------------------------------------------------------- solver ---
  SUB_DT: 1 / 120, // fixed physics timestep
  MAX_SUBSTEPS: 5,
  ITERATIONS: 10, // constraint relaxation passes per substep
  DAMPING: 0.72, // velocity damping per substep; high damping = heavy/deliberate

  // While on the wall the body is quasi-static, NOT a dynamics sim. Gravity is
  // applied as a downward positional drift that the tethers immediately arrest,
  // rather than an acceleration that accumulates kinetic energy the constraints
  // then have to dissipate. Feeding stiff constraint corrections back into
  // velocity at full strength is what makes a PBD ragdoll vibrate; VEL_FEEDBACK
  // keeps just enough for the body to have follow-through and weight.
  GRAVITY_SAG: 330, // world units / s of downward drift
  VEL_FEEDBACK: 0.15, // fraction of solved motion carried as momentum
  // How a limb's correction is split between the two body points. Hands push
  // mostly the chest, feet mostly the hip -- this is what makes the torso lean
  // and rotate rather than just slide.
  ANCHOR_SPLIT_NEAR: 0.75,
  UPRIGHT_STIFF: 0.012, // weak bias keeping the chest above the hip
  FOOT_PUSH_STIFF: 0.9, // legs pressing the body up off a foothold
  // ...saturating here, in world units per second. A deeply folded leg would
  // otherwise ask to shove the body 10u in one substep -- four times gravity's sag
  // -- which no clamp reconciles and which alternated at 60Hz. Ordinary standing
  // corrections are ~3u/substep and sit well under this, so the mechanic is
  // untouched: measured strain at rest is the same as before the cap, where
  // softening the stiffness instead cost 0.1 of it.
  FOOT_PUSH_RATE: 900,
  FOOT_PUSH_REACH: 1.05,
  CLAMP_STIFF: 1.0, // hard min/max reach clamps (planted limbs tether here)
  PROJECT_PASSES: 16, // strict reach projection after relaxation; see projectReach
  // Reach-only sweeps after those, so the envelope is genuinely the last thing
  // enforced. Without them every projection pass ends with pose/torso/tilt moving
  // the body after the clamps ran, and a planted limb can be left over-stretched
  // no matter how many passes it gets -- drawn as a rubber limb.
  REACH_FINAL_PASSES: 4,
  // The relaxation is local, so it has more than one stable answer per stance and
  // can settle in a bad one -- see escapeWedge. Past this much violation left
  // standing AFTER a substep has finished solving, with nothing being dragged, the
  // body migrates toward solveStatic's global answer. Trigger is well above the
  // ~0.6u of ordinary solver noise.
  //
  // The two rates are a genuine speed limit -- units/s and degrees/s toward the
  // better answer -- not a fraction of the distance remaining. That distinction
  // was the whole bug: `min(1, 90 * dt)` closes 75% of the gap per substep at
  // 120Hz, so a wedge escape fired on a transient threw the body 18u and the
  // solver walked it back, over and over.
  //
  // Both rates are then scaled by urgency = violation / WEDGE_REF, capped. A
  // serious wedge (WEDGE_REF and up -- the ones this exists for measured 60-85u)
  // moves at full speed and clears inside the 45-substep recovery lead `npm run
  // fuzz` allows. A 2u violation moves at a tenth of that, which is invisible per
  // substep and, crucially, does not overshoot into a state the local solver will
  // undo -- that overshoot was a 9Hz sawtooth on the stances where a limb sits just
  // inside its minimum length.
  WEDGE_TRIGGER: 2.0,
  WEDGE_RECOVER: 400, // world units / second at full urgency
  WEDGE_TURN: 1200, // degrees / second at full urgency
  WEDGE_REF: 8, // violation counted as a full-urgency wedge, world units
  WEDGE_URGENCY_MAX: 4,
  // How long the escape may keep pushing at one set of holds before giving up on
  // it. Some stances have a better global answer that the local relaxation simply
  // refuses to hold, and then the two solvers take turns forever -- measured as a
  // 9Hz, 4u twitch that never ended. This is deliberately a hair under the 0.375s
  // recovery lead `npm run fuzz` allows, so a genuine wedge still clears.
  WEDGE_BUDGET: 1.0, // seconds, per stance
  WEDGE_REARM: 0.25, // budget recovered per second of clean time, as a rate
  // Applied once per substep (see applyDragPull), multiplying the shortfall past
  // LUNGE_START. This is a stability limit, not a taste knob: the anchor takes ~3/4
  // of the move, so past an effective gain of 1 the body overshoots the threshold,
  // and past ~2 it overshoots by more than it was short, which rings. Measured over
  // 200 moves x 5 levels, plant rate plateaus at 2.0 (94%) and the only thing
  // higher values buy is chatter -- 0 bouncing windows at 2.0, 53 at 6.0.
  //
  // It was 6.0 against an error term ~11u larger (the distance to a settle target
  // rather than the shortfall itself), which is a much gentler pull than the number
  // suggests. Don't read across from the old value.
  DRAG_PULL: 2.5, // how hard a dragged limb drags the body toward the target
  // Damps the upward component: hauling yourself up is muscular work, leaning
  // sideways is nearly free. This used to be 0.4 to stop a reach levitating the
  // figure, but that was compensating for feet that could not limit the body.
  // Now that a planted leg hard-limits it, the damping can be gentle.
  DRAG_LIFT: 0.8,
  // Where the lunge starts, as a fraction of the limb's max reach. Don't shift the
  // body for anything the limb can comfortably touch: lunging from the *preferred*
  // length (0.74) meant every reach hauled the body up, over-extended both legs and
  // peeled both feet off.
  //
  // It sits just INSIDE max reach rather than exactly at it, which is what replaced
  // the old second threshold (LUNGE_SETTLE, 0.84). The pull now aims at this same
  // line -- see applyDragPull -- so the body settles a fraction of a unit past it
  // and the hold ends up genuinely in reach, which is what the settle target was
  // for. Two separate lines, one to arm the pull and one to aim it, is what made
  // the lunge oscillate. Measured at 0.95: no bouncing left in `npm run jitter`,
  // and plant rate is unchanged.
  LUNGE_START: 0.95,
  // ...and how deep it aims once the player is genuinely hauling, likewise as a
  // fraction of max reach. Two aims, selected by pointer speed, because the two
  // failure modes live in different regimes: aiming deep with the pointer STILL is a
  // bang-bang controller and rings at 60Hz, while aiming only at the threshold
  // leaves the socket a hair out of reach at release and refuses grabs the player
  // can see land -- half of all missed grabs, with the hand drawn right on the hold.
  LUNGE_SETTLE: 0.84,
  // Pointer speed, world units/s, at which the aim is fully committed. An ordinary
  // drag covers a limb's length in half a second, so ~120 is "actually reaching".
  LUNGE_COMMIT_SPEED: 120,
  LUNGE_SPEED_ATTACK: 0.05, // seconds; commit the moment they start hauling...
  LUNGE_SPEED_RELEASE: 0.35, // ...and let go of it slowly, so a pause is survivable
  // Hard ceiling on how far one dragged limb may displace the body in a single
  // substep. DRAG_PULL multiplies the *shortfall*, which is unbounded: drag a
  // limb to 3x its reach and the lunge asks for 880 units of body travel in one
  // 1/120s step. The constraints usually claw that back within the substep --
  // measured 555u right after the drag, 0u after projection -- but from some
  // configurations they cannot, and that is what let a planted limb sit 200u
  // past its length and the torso invert. Normal play peaks at 66u/substep, so
  // this bounds the pathological case without touching the intended feel.
  DRAG_MAX_STEP: 110,
  // Hard cap on torso tilt from vertical, degrees. The pose cones live in the
  // torso frame, so an inverted torso mirrors every anatomical limit and they
  // stop meaning anything -- a foot "below the hip" in torso space is above it in
  // the world. Normal play reaches 46 degrees, so this is slack in practice and
  // exists only to keep the frame interpretable.
  TORSO_TILT_MAX: 72,

  // Elasticity in reach: past max the limb keeps moving, but with exponential
  // resistance, asymptotically capped at max + REACH_STRETCH. Tight, on purpose.
  REACH_STRETCH: 9,

  DANGLE_LERP: 0.22, // how fast an unplanted limb settles to hanging

  // ----------------------------------------------------------------- input ---
  GRAB_RADIUS: 42, // how close a pointer must land to pick up a limb
  SNAP_RADIUS: 34, // how close the limb endpoint must be to a hold to plant
  PLANT_TOLERANCE: 1.0, // multiple of max reach still allowed to plant
  // A grab is refused if the resulting four-hold stance has no solution at all --
  // see stanceSolvable. Legal stances settle at ~0-0.6u, and the configurations
  // this exists to reject sit tens of units out, so this only has to clear solver
  // noise. The brief already says an unreachable grab simply fails; this is the
  // same rule applied to the stance as a whole rather than to one limb.
  PLANT_MAX_VIOLATION: 2.0,
  // A touch that never travels this far is a tap, which releases the limb.
  // Small enough that a tap is deliberate, large enough that a thumb resting on
  // a limb doesn't start dragging it.
  TAP_SLOP: 5,
  // A stance whose violation stays this bad for this long is not a stance the body
  // is in -- it is one no body could be in, and the game drops you.
  //
  // Releasing a limb was assumed to be always safe, on the grounds that it only
  // removes constraints. That is false for hands: let both of them go and you are
  // left hanging from two feet, which POSE.FOOT_RISE forbids outright, so the solver
  // is asked for a position that does not exist and draws a leg folded up past the
  // head. `npm run fuzz` reaches it by dragging two limbs at once and failing to
  // re-plant either, and a player poking at the toy will find it in seconds.
  // Physically you have just let go of the wall with nothing under you, so: you fall.
  //
  // The threshold is far above anything ordinary play produces (route stances settle
  // under 3u, and the worst wedge the escape recovers from is ~20u) and far below
  // the 55u this exists to catch. The delay is longer than the wedge escape's own
  // recovery, so a stance being fixed is never mistaken for one being lost.
  FALL_VIOLATION: 30,
  FALL_VIOLATION_TIME: 0.3,
  FALL_LINGER: 0.85, // seconds watching yourself fall before the retry overlay
  // How decisive the outboard test must be before a joint may switch bend side.
  // Near zero the limb is pointing sideways and the test is meaningless, so the
  // previous side is kept -- otherwise knees snap mid-move.
  BEND_HYSTERESIS: 0.78,

  // ---------------------------------------------------------------- stamina ---
  // Strain is a single 0..~2 scalar built from three signals. Below REST_STRAIN
  // you recover; above it you drain. That threshold is the whole pacing knob.
  W_HOLD: 0.55,
  W_FLEX: 0.4,
  W_BALANCE: 0.45,
  W_ARMLOAD: 0.45, // cost of simply having weight on your arms
  // Calibrated against the measured spread of real route stances, which runs
  // p25 0.30 / median 0.38 / p90 0.66, so roughly the best third of positions on the
  // wall offer a rest and you have to hunt for them. Harder levels get far fewer by
  // design. Re-measure with `npm run measure` if the strain terms change -- and note
  // that a SOLVER change moves this too: the jitter fix left the figure standing a
  // little lower (37% of bodyweight on the arms, up from 29%), which pushed every
  // stance's strain up ~0.02 and cost 8 points of rest fraction until this followed.
  REST_STRAIN: 0.32,

  DRAIN_RATE: 0.16, // stamina/sec per unit of net strain
  RECOVER_RATE: 0.5, // stamina/sec per unit of net (negative) strain
  STAMINA_SMOOTH: 6, // low-pass on strain so it doesn't flicker while dragging

  HOLD_EXP: 1.4, // curve on (1 - quality); higher = bad holds bite harder

  // FLEXION, not extension, is what costs you. A straight arm hangs off bone and
  // connective tissue and is nearly free; the bent, locked-off arm is what
  // burns. Legs are the same shape: a straight leg is cheap, a deep high step is
  // brutal. Cost runs from 0 at `straight` to 1 at `folded`, as a fraction of
  // max reach. (This inverts the brief's original extension rule -- see the
  // revision note in docs/BRIEF.md.)
  FLEX: {
    ARM: { straight: 0.92, folded: 0.42 },
    LEG: { straight: 0.9, folded: 0.45 },
  },
  FLEX_EXP: 1.6,

  FOOT_STRAIN_MULT: 0.4, // legs are much stronger than arms

  // Load distribution. Each contact's share of bodyweight comes from how well it
  // opposes gravity and how close the centre of mass sits to it, rather than
  // from a fixed per-limb-type constant. This is what makes moving your hips
  // over your feet actually unload your arms.
  LOAD_FALLOFF: 70, // world units; COM this far from a contact halves its share
  LOAD_FLOOR: 0.05, // a contact always carries at least a little
  LOAD_STAND_SPAN: 60, // a foot this far below the COM counts as fully stood-on
  HAND_HANG_BIAS: 0.2, // fraction the arms keep even with perfect feet

  // Balance. Gravity only destabilises you sideways, so this measures the COM's
  // horizontal offset from the contacts actually carrying it. True barn-dooring
  // rotates out of the wall plane and we don't model depth -- see stamina.js.
  BALANCE_SCALE: 48, // world units of sideways COM offset == 1.0 strain
  BALANCE_BASE_SPAN: 55, // loaded-contact spread narrower than this is a narrow base
  BALANCE_NARROW: 1.0, // extra multiplier at maximum narrowness
  BALANCE_MIN_SHARE: 0.08, // a contact carrying less than this doesn't widen the base
  W_MANTEL: 0.35, // penalty for COM sitting above a loaded hand (pressing)

  // ------------------------------------------------------------------ holds ---
  HOLD_R_MIN: 3.5, // radius of a 0-quality crimp
  HOLD_R_MAX: 10, // radius of a 1-quality jug

  // -------------------------------------------------------------- generator ---
  SEED: 20260808, // seed for level 1; each level below carries its own
  ROUTE_MOVES: 600, // how many limb moves of guaranteed-climbable route
  GEN_CANDIDATES: 48, // sampling attempts per move before relaxing the ask
  GEN_SOLVE_ITERS: 60, // relaxation passes in the headless feasibility check
  // Feasible stances converge to ~0 violation and impossible ones sit tens of
  // units out, so this only has to absorb solver noise.
  GEN_TOLERANCE: 0.6, // world units of constraint violation still called "OK"

  // Move distance and hold quality both ramp with height.
  DIFF_FULL_HEIGHT: 5000, // height at which difficulty reaches 1.0

  // The five walls on the menu. A level is a *floor* under the same easy->hard
  // scalar the height ramp already drives (see difficultyAt), so one number per
  // level moves hold quality, filler density and move distance together and there
  // is no second difficulty system to keep in sync. Level 1 is floor 0 -- the
  // wall the prototype had before the menu existed.
  //
  // The floors are spaced on measured results, not by eye. `npm run ladder`
  // prints this table; the columns that matter are how far the auto-climber gets
  // and how many moves it makes before pumping out:
  //
  //   lvl  floor  holds/100u  hold q  choices  stuck  rests  climbed  moves
  //    1    0.00      9.0       0.79     12.5   0.13    40%    1983u   171
  //    2    0.20      7.6       0.66      8.0   0.37    28%    1326u   102
  //    3    0.45      6.0       0.50      8.0   0.33    19%    1297u    94
  //    4    0.70      5.7       0.34      6.0   0.93     6%    1060u    68
  //    5    1.00      4.4       0.15      4.5   1.13     2%     796u    46
  //
  // `choices` is how many legal moves a stance offers and `stuck` how many of the
  // four limbs have none. Level 5 averages more than one limb with nowhere to go,
  // which is the point: you have to work out which limb can move, and in what
  // order. Note the auto-climber never rests deliberately, so a human gets
  // further -- these are for spacing the rungs, not for predicting scores.
  //
  // Move distance is NOT the lever it looks like. MOVE_DIST ramps 52 -> 84 across
  // the ladder but the *achieved* move only goes 62 -> 69, because a limb move is
  // capped by anatomy (ARM.max 68, LEG.max 80) and the generator's feasibility
  // check refuses anything longer. Asking for still-longer moves just costs plant
  // rate. Hold REUSE, not move distance, is what makes a hard wall sparse.
  LEVELS: [
    { name: 'SLAB', blurb: 'jugs all the way up', floor: 0.0, seed: 20260808 },
    { name: 'STEEP', blurb: 'fewer holds, longer moves', floor: 0.2, seed: 41773 },
    { name: 'OVERHUNG', blurb: 'small holds, rests are rare', floor: 0.45, seed: 90211 },
    { name: 'ROOF', blurb: 'crimps, no rests', floor: 0.7, seed: 155317 },
    { name: 'PROJECT', blurb: 'nothing given away', floor: 1.0, seed: 262147 },
  ],
  MOVE_DIST: { easy: 52, hard: 84 }, // target reach per move, lerped by difficulty

  // Chance the generator tries to move a limb onto a hold that already exists
  // rather than placing a new one. This is what makes a hard wall *sparse*: with
  // one new hold per limb move the wall has a fixed ~9.5 holds per 100u no matter
  // what else you tune, because a limb can only move so far. Reuse breaks that
  // link -- a foot steps onto the hold a hand left two moves ago, and the move
  // costs no hold at all.
  //
  // It is also what makes order matter, which is the point: on a sparse wall
  // there may be no legal right-hand move until the right foot has moved, and no
  // legal right-foot move until the left foot has. See `npm run ladder`, which
  // reports how many moves are available per stance.
  REUSE: { easy: 0.0, hard: 0.97 },
  REUSE_RANGE: 1.25, // how far past the target move distance to look, as a multiple
  REUSE_GAIN: 0.3, // ...and the minimum height gain, likewise
  REUSE_TRIES: 10, // feasibility solves per reuse attempt, best-first
  MOVE_SPREAD: 48, // lateral jitter when sampling candidates
  // The route is a random walk, which left alone hugs the centre of the wall and
  // stacks on itself. A slow lateral drift makes it traverse and use the width.
  MOVE_DRIFT: { amp: 0.2, period: 900, pull: 0.3 },
  // The hard ends of these two were 0.3 / 0.12 when there was one wall, which is
  // as hard as "the top of a long climb" needs to be. Spanning five levels needs
  // more headroom: at 0.3 the top three rungs all collapsed onto the same wall
  // (the auto-climber reached 1103/1008/1015u -- levels 4 and 5 were the same
  // difficulty). Extending them to 0.1 / 0.04 spread that to 1113/990/863u.
  //
  // These no longer leave level 1's route geometry bit-identical to the pre-menu
  // wall, and nothing can: the generator commits a hold only if the body solver says
  // the stance holds, so any change to the solver reshuffles every wall. The
  // guarantee that survives is the one that matters -- `npm run verify` re-proves
  // every route stance on every level, whatever the seeds produce.
  QUALITY_ROUTE: { easy: 0.95, hard: 0.1 },
  QUALITY_FILL: { easy: 0.7, hard: 0.04 },
  QUALITY_JITTER: 0.16,
  FILL_DENSITY: { easy: 0.5, hard: 0.04 }, // filler holds per route hold
  FILL_MIN_GAP: 30, // don't drop filler this close to an existing hold

  // ----------------------------------------------------------------- camera ---
  CAM_ANCHOR: 0.58, // figure sits this far down the screen
  CAM_LERP: 6, // follow stiffness (per second)

  // ------------------------------------------------------------------- theme ---
  COL: {
    bg0: '#0b0d11',
    bg1: '#161b23',
    grid: 'rgba(255,255,255,0.045)',
    ground: '#2a3140',
    figure: '#e8edf5',
    figureDim: '#7f8b9e',
    joint: '#aab6c8',
    planted: '#7dd3a0',
    dragging: '#ffd166',
    reach: 'rgba(255,209,102,0.16)',
    holdGood: '#5fb3d4',
    holdBad: '#8d6b8f',
    inRange: '#ffd166',
    stamHi: '#7dd3a0',
    stamMid: '#ffd166',
    stamLo: '#ef6f6c',
    text: '#dfe6f0',
    textDim: '#7f8b9e',
  },
};

/**
 * The one easy->hard scalar: 0 at the ground, 1 at DIFF_FULL_HEIGHT and above.
 *
 * `floor` is the chosen level's starting difficulty. The ramp is applied to
 * what's *left* above the floor, so every level still gets harder as you climb
 * and no level can exceed 1.0. floor 0 reproduces the pre-menu behaviour exactly.
 */
export function difficultyAt(height, floor = 0) {
  const ramp = Math.max(0, Math.min(1, height / T.DIFF_FULL_HEIGHT));
  return floor + (1 - floor) * ramp;
}

/** Clamp a menu level index to a real one, and hand back its definition. */
export function levelAt(index) {
  return T.LEVELS[clamp(index | 0, 0, T.LEVELS.length - 1)];
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
