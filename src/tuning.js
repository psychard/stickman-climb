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

  // Feet are conditional contacts: they're held on by compression and by being
  // somewhere a leg can actually push from. Both failure modes drop the foot.
  //
  // A foot resists compression but cannot hold you in tension, so past this much
  // over-extension it comes off. Over-reaching with your feet is a risk, not a
  // free anchor.
  FOOT_PEEL_SLACK: 6,
  // ...and a foot dragged this far outside its anatomical cone -- up above the
  // hip, or wrapped across the body -- has no purchase left either.
  POSE_PEEL: 10,

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
  FOOT_PUSH_STIFF: 0.22, // legs pressing the body up off a foothold
  CLAMP_STIFF: 1.0, // hard min/max reach clamps (planted limbs tether here)
  DRAG_PULL: 0.3, // how hard a dragged limb drags the body toward the target

  // Elasticity in reach: past max the limb keeps moving, but with exponential
  // resistance, asymptotically capped at max + REACH_STRETCH. Tight, on purpose.
  REACH_STRETCH: 9,

  DANGLE_LERP: 0.22, // how fast an unplanted limb settles to hanging

  // ----------------------------------------------------------------- input ---
  GRAB_RADIUS: 42, // how close a pointer must land to pick up a limb
  SNAP_RADIUS: 34, // how close the limb endpoint must be to a hold to plant
  PLANT_TOLERANCE: 1.0, // multiple of max reach still allowed to plant

  // ---------------------------------------------------------------- stamina ---
  // Strain is a single 0..~2 scalar built from three signals. Below REST_STRAIN
  // you recover; above it you drain. That threshold is the whole pacing knob.
  W_HOLD: 0.55,
  W_FLEX: 0.4,
  W_BALANCE: 0.45,
  W_ARMLOAD: 0.45, // cost of simply having weight on your arms
  // Calibrated against the measured spread of real route stances, which runs
  // p25 0.32 / median 0.41 / p90 0.73. Sitting just under the p25 means roughly
  // the best quarter of positions on the wall offer a rest, so you have to hunt
  // for them. Re-measure with tools/ if the strain terms change.
  REST_STRAIN: 0.3,

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
  SEED: 20260808, // the one fixed prototype seed
  ROUTE_MOVES: 600, // how many limb moves of guaranteed-climbable route
  GEN_CANDIDATES: 48, // sampling attempts per move before relaxing the ask
  GEN_SOLVE_ITERS: 60, // relaxation passes in the headless feasibility check
  // Feasible stances converge to ~0 violation and impossible ones sit tens of
  // units out, so this only has to absorb solver noise.
  GEN_TOLERANCE: 0.6, // world units of constraint violation still called "OK"

  // Move distance and hold quality both ramp with height.
  DIFF_FULL_HEIGHT: 5000, // height at which difficulty reaches 1.0
  MOVE_DIST: { easy: 52, hard: 84 }, // target reach per move, lerped by difficulty
  MOVE_SPREAD: 48, // lateral jitter when sampling candidates
  // The route is a random walk, which left alone hugs the centre of the wall and
  // stacks on itself. A slow lateral drift makes it traverse and use the width.
  MOVE_DRIFT: { amp: 0.2, period: 900, pull: 0.3 },
  QUALITY_ROUTE: { easy: 0.95, hard: 0.3 },
  QUALITY_FILL: { easy: 0.7, hard: 0.12 },
  QUALITY_JITTER: 0.16,
  FILL_DENSITY: { easy: 0.5, hard: 0.12 }, // filler holds per route hold
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

/** 0 at the ground, 1 at DIFF_FULL_HEIGHT and above. */
export function difficultyAt(height) {
  return Math.max(0, Math.min(1, height / T.DIFF_FULL_HEIGHT));
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
