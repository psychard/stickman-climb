/**
 * Which constants the tuner exposes, what class each belongs to, and which
 * measurement tool settles it.
 *
 * **This file stores no defaults.** That is the rule that keeps it from
 * violating "every tuning knob lives in src/tuning.js": there is still exactly
 * one place a number is written down. Delete this file and the game is
 * bit-identical -- nothing under src/ imports it. Slider ranges are *derived*
 * from whatever tuning.js currently says (see rangeFor in page.js), so moving a
 * default here is impossible and moving one there needs no edit here.
 *
 * A domain bound is not a default. `UNIT` says "this constant is a 0..1 fraction
 * by meaning", which stays true however the value moves, so it does not become a
 * second source of truth. `SPAN` holds *multipliers*, for the same reason.
 *
 * Groups rather than one entry per constant, so adding a knob is one word in a
 * list rather than five lines of metadata.
 *
 * v1 exposes FEEL and CALIBRATION only. The classes below the fold record why
 * each of the other ~186 leaves is not a slider, and `npm run tune:check`
 * enforces that every leaf in T is accounted for by one list or the other --
 * which is the direction that actually rots, because it is the one that catches
 * a constant somebody added and nobody classified.
 */

/**
 * The exposed knobs.
 *
 * `after` is the follow-up the game must run once the value lands. Every v1
 * constant is read per-frame, so all of them are 'none'; the field exists so
 * that growing into the generator later is an edit here and not a change to
 * src/tune.js.
 */
export const GROUPS = [
  {
    class: 'FEEL',
    after: 'none',
    invalidates: [],
    note: 'nothing scores these but a hand on a phone',
    keys: [
      'CAM_ANCHOR',
      'CAM_LERP',
      'GRAB_RADIUS',
      'SNAP_RADIUS',
      'TAP_SLOP',
      'REACH_STRETCH',
      'DANGLE_LERP',
      'DRAG_LIFT',
      'DAMPING',
      'VEL_FEEDBACK',
      'STAMINA_SMOOTH',
      'BEND_HYSTERESIS',
      'TOP_HOLD_TIME',
      'TOP_LINGER',
      'FALL_LINGER',
      'CATCH_STAMINA',
    ],
  },
  {
    class: 'CALIBRATION',
    after: 'none',
    invalidates: ['measure'],
    note: 'settled against a measured distribution, not a feeling -- watch the percentiles',
    keys: [
      'REST_STRAIN',
      'DRAIN_RATE',
      'RECOVER_RATE',
      'W_HOLD',
      'W_FLEX',
      'W_BALANCE',
      'W_ARMLOAD',
      'W_MANTEL',
      'HOLD_EXP',
      'FLEX_EXP',
      'FOOT_STRAIN_MULT',
      'NOHANDS_FOOT_GRIP',
      'FLEX.ARM.straight',
      'FLEX.ARM.folded',
      'FLEX.LEG.straight',
      'FLEX.LEG.folded',
      'LOAD_FALLOFF',
      'LOAD_FLOOR',
      'LOAD_STAND_SPAN',
      'HAND_HANG_BIAS',
      'BALANCE_SCALE',
      'BALANCE_BASE_SPAN',
      'BALANCE_NARROW',
      'BALANCE_MIN_SHARE',
    ],
  },
];

/** Constants that are 0..1 fractions by meaning, whatever their current value. */
export const UNIT = new Set([
  'CAM_ANCHOR',
  'DAMPING',
  'VEL_FEEDBACK',
  'DANGLE_LERP',
  'BEND_HYSTERESIS',
  'LOAD_FLOOR',
  'HAND_HANG_BIAS',
  'BALANCE_MIN_SHARE',
  'FLEX.ARM.straight',
  'FLEX.ARM.folded',
  'FLEX.LEG.straight',
  'FLEX.LEG.folded',
]);

/**
 * Multipliers of the committed default, where "0 to twice it" is the wrong span.
 * REST_STRAIN is the one that matters: strain on real stances runs to p90 0.44
 * against a default of 0.26, so a 2x ceiling stops just short of the range where
 * the interesting question ("how many stances should rest?") actually lives.
 */
export const SPAN = {
  REST_STRAIN: [0, 2.5],
};

/**
 * One line per exposed knob, because the names do not carry themselves --
 * `HAND_HANG_BIAS` and `LOAD_STAND_SPAN` are not guessable, and a slider you
 * cannot name the meaning of is one you tune by watching the figure twitch.
 *
 * This is prose, not a value: it says what a constant *is*, never what it is set
 * to, so it cannot become a second source of truth for a number. `npm run
 * tune:check` requires one for every exposed path, so a knob cannot be added
 * without one.
 *
 * Distances are world units, which are about a CSS pixel on a 400pt-wide phone.
 */
export const DESC = {
  // ---------------------------------------------------------------- feel
  CAM_ANCHOR: 'How far down the screen the figure sits. Higher shows more wall above you.',
  CAM_LERP: 'How stiffly the camera chases the figure, per second. Low is floaty, high is locked on.',
  GRAB_RADIUS: 'How near a finger must land to a hand or foot to pick it up.',
  SNAP_RADIUS: 'How near the limb must end up to a hold to plant on it when you let go.',
  TAP_SLOP:
    'A touch that travels less than this is a tap, which releases the limb rather than dragging it.',
  REACH_STRETCH:
    'Cosmetic give past max reach: the limb draws this much longer under load. Does not change what you can grab.',
  DANGLE_LERP: 'How quickly a limb that is off the wall settles back to hanging.',
  DRAG_LIFT:
    'Damping on the upward half of a lunge. Below 1, hauling yourself up is harder than leaning sideways.',
  DAMPING: 'Velocity kept per substep. High reads as heavy and deliberate, low as twitchy.',
  VEL_FEEDBACK:
    'How much of the solved motion carries as momentum, so the body has follow-through instead of snapping.',
  STAMINA_SMOOTH: 'Low-pass on strain, so the stamina bar does not flicker while you drag.',
  BEND_HYSTERESIS:
    'How decisive the test must be before a knee or elbow may flip which way it bends. Low makes joints snap mid-move.',
  TOP_HOLD_TIME:
    'Seconds both hands must stay on the finish hold to send it — controlling the top, not slapping it.',
  TOP_LINGER: 'Seconds of TOPPED on screen before the menu comes back.',
  FALL_LINGER: 'Seconds lying on the ground before the menu comes back.',
  CATCH_STAMINA:
    'Stamina a mid-fall catch hands back, if you had less. 0..1. Most catches are ' +
    'catches from empty, so below about 0.1 the save is undone on the next frame.',

  // --------------------------------------------------------- calibration
  REST_STRAIN:
    'The pacing knob: strain under this recovers stamina, over it drains. Real stances run p25 0.23 / median 0.30 / p90 0.44.',
  DRAIN_RATE: 'Stamina lost per second, per unit of strain above the rest threshold.',
  RECOVER_RATE: 'Stamina regained per second, per unit of strain below the rest threshold.',
  W_HOLD: 'How much of strain comes from hold quality — what bad holds cost you.',
  W_FLEX: 'How much of strain comes from bent limbs — what locking off costs you.',
  W_BALANCE: 'How much of strain comes from your weight hanging off to one side.',
  W_ARMLOAD: 'How much of strain comes from simply having weight on your arms, good holds or not.',
  W_MANTEL: 'Extra cost when your weight sits above a loaded hand, i.e. pressing out a mantel.',
  HOLD_EXP: 'Curve on hold badness. Higher makes the very worst holds bite disproportionately.',
  FLEX_EXP: 'Curve on limb bend. Higher makes a deep fold disproportionately expensive.',
  FOOT_STRAIN_MULT: 'How much cheaper a leg is than an arm. Legs are much stronger.',
  NOHANDS_FOOT_GRIP:
    'What a foothold costs when both hands are off the wall and it is all that is keeping you on. At FOOT_STRAIN_MULT, letting go is a free rest.',
  'FLEX.ARM.straight':
    'Arm length counted as straight and therefore free, as a fraction of max reach.',
  'FLEX.ARM.folded': 'Arm length counted as fully folded, as a fraction of max reach.',
  'FLEX.LEG.straight': 'Leg length counted as straight and therefore free, as a fraction of max.',
  'FLEX.LEG.folded': 'Leg length counted as a full deep step, as a fraction of max.',
  LOAD_FALLOFF: 'How far your centre of mass can sit from a contact before its share of your weight halves.',
  LOAD_FLOOR: 'The least share of your weight any contact carries, however badly placed.',
  LOAD_STAND_SPAN: 'How far below your centre of mass a foot must be to count as fully stood on.',
  HAND_HANG_BIAS: 'The share of weight your arms keep even with perfect footwork.',
  BALANCE_SCALE: 'Sideways offset of the centre of mass that counts as a full unit of balance strain.',
  BALANCE_BASE_SPAN:
    'Loaded contacts closer together than this count as a narrow base, which makes the same lean worse.',
  BALANCE_NARROW: 'Extra multiplier on balance strain when your base is as narrow as it gets.',
  BALANCE_MIN_SHARE: 'A contact carrying less than this share does not count towards widening your base.',
};

/**
 * Everything else in T, and why it is not a slider. Patterns may use `*` for
 * exactly one segment, so a seventh style or a sixth hold kind is covered while
 * a *new field* on one still fails the check -- which is the right sensitivity: a
 * new row in a table is routine, a new field is a new knob.
 */
export const UNTUNED = [
  {
    why: 'locked',
    note: 'refused by src/overrides.js LOCKED, with the reason attached there',
    keys: [
      'SUB_DT',
      'MAX_SUBSTEPS',
      'WALL_W',
      'GROUND_Y',
      'REF_DAY',
      'HISTORY_DAYS',
      'PROBLEMS_PER_LEVEL',
    ],
  },
  {
    why: 'stability',
    note: 'owned by sim/jitter/fuzz; the failure mode is a limit cycle you cannot feel in 30s. Reach these with --set',
    keys: [
      'ITERATIONS',
      'GRAVITY_SAG',
      'ANCHOR_SPLIT_NEAR',
      'UPRIGHT_STIFF',
      'POSE_STIFF',
      'CLAMP_STIFF',
      'PROJECT_PASSES',
      'REACH_FINAL_PASSES',
      'FOOT_PUSH_STIFF',
      'FOOT_PUSH_RATE',
      'FOOT_PUSH_REACH',
      'WEDGE_TRIGGER',
      'WEDGE_RECOVER',
      'WEDGE_TURN',
      'WEDGE_REF',
      'WEDGE_URGENCY_MAX',
      'WEDGE_BUDGET',
      'WEDGE_REARM',
      'DRAG_PULL',
      'DRAG_MAX_STEP',
      'LUNGE_START',
      'LUNGE_SETTLE',
      'LUNGE_COMMIT_SPEED',
      'LUNGE_SPEED_ATTACK',
      'LUNGE_SPEED_RELEASE',
      'TORSO_TILT_MAX',
    ],
  },
  {
    why: 'coupled',
    note: 'TOPPLE_MAX caps the overhang and therefore the burn rate, so MAX and REF are not independent -- a slider on one alone silently retunes the other',
    keys: [
      'TOPPLE_MARGIN',
      'TOPPLE_STIFF',
      'TOPPLE_RATE',
      'TOPPLE_REF',
      'TOPPLE_BUDGET',
      'TOPPLE_REARM',
      'TOPPLE_MAX',
    ],
  },
  {
    why: 'anatomy',
    note: 'the generator commits a hold only if the solver says the stance holds, so these reshuffle every wall -- needs verify, not a slider',
    keys: [
      'TORSO_LEN',
      'SHOULDER_HALF',
      'HIP_HALF',
      'HEAD_R',
      'ARM.*',
      'LEG.*',
      'POSE.*',
    ],
  },
  {
    why: 'threshold',
    note: 'sized against measured noise floors (legal stances settle under 3u, the cases these reject sit tens of units out), not against how anything feels',
    keys: ['PLANT_TOLERANCE', 'PLANT_MAX_VIOLATION', 'FALL_VIOLATION', 'FALL_VIOLATION_TIME'],
  },
  {
    why: 'generation',
    note: 'baked into a wall at build time and decides climbability, which only verify can see; a property of thirty walls rather than the one you are on',
    keys: [
      'GEN_CANDIDATES',
      'GEN_SOLVE_ITERS',
      'GEN_TOLERANCE',
      'STANCE_ARM_TARGET',
      'STANCE_WEIGH',
      'DIFF_FULL_HEIGHT',
      'MOVE_DIST.*',
      'MOVE_SPREAD',
      'MOVE_DRIFT.*',
      'PROBLEM_RISE',
      'PROBLEM_MOVE_CAP',
      'PROBLEM_RETRIES',
      'TOP_TRIES',
      'REUSE.*',
      'REUSE_RANGE',
      'REUSE_GAIN',
      'REUSE_TRIES',
      'QUALITY_ROUTE.*',
      'QUALITY_FILL.*',
      'QUALITY_JITTER',
      'FILL_DENSITY.*',
      'FILL_MIN_GAP',
      'HOLD_R_MIN',
      'HOLD_R_MAX',
      'HOLD_KINDS.*.from',
      'HOLD_KINDS.*.to',
      'LEVELS.*.floor',
      'LEVELS.*.seed',
      'STYLES.*.rise',
      'STYLES.*.drift',
      'STYLES.*.dist',
      'STYLES.*.cross',
      'STYLES.*.pull',
    ],
  },
  {
    why: 'free-fall only',
    note: 'GRAVITY applies once you are already off; MAX_PLAY_W is desktop letterboxing and there is nothing to judge on a phone',
    keys: ['GRAVITY', 'MAX_PLAY_W'],
  },
  {
    why: 'cosmetic',
    note: 'text and colour. Visual polish is out of scope per the brief, and 16 colours want pickers rather than sliders',
    keys: [
      'COL.*',
      'LEVELS.*.name',
      'LEVELS.*.blurb',
      'STYLES.*.id',
      'STYLES.*.name',
      'STYLES.*.blurb',
      'STYLES.*.feature',
      'HOLD_KINDS.*.name',
      'HOLD_KINDS.*.col',
    ],
  },
];

/** Every exposed path, flat. */
export function tunedPaths() {
  return GROUPS.flatMap((g) => g.keys);
}

/** The group a path belongs to, or undefined. */
export function groupFor(path) {
  return GROUPS.find((g) => g.keys.includes(path));
}

/** Does `path` match a pattern whose `*` segments are single-segment wildcards? */
export function matchesPattern(path, pattern) {
  const p = path.split('.');
  const q = pattern.split('.');
  if (p.length !== q.length) return false;
  return q.every((seg, i) => seg === '*' || seg === p[i]);
}

/** The UNTUNED entry covering `path`, or undefined. */
export function untunedFor(path) {
  return UNTUNED.find((u) => u.keys.some((k) => matchesPattern(path, k)));
}
