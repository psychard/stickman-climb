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
  // Legs pressing the body up off a foothold. Applied ONCE per substep as an
  // external input (see applyFootPush) -- it used to run inside every relaxation
  // pass, which is how it beat the reach clamps and oscillated. The stiffness is
  // 4x what it was for exactly that reason: ten applications of 0.22 and one of 0.9
  // have about the same authority per substep, and dropping the authority instead
  // measured as the figure hanging off its arms (45% of bodyweight, vs 37% now).
  FOOT_PUSH_STIFF: 0.9,
  // ...saturating here, in world units per second. A leg folded up under the hip --
  // an ordinary high step -- would otherwise ask to shove the body 10u in a single
  // 1/120s substep, which no clamp reconciles and which alternated at 60Hz.
  FOOT_PUSH_RATE: 900,
  // ...and pressing toward slightly STRAIGHTER than the relaxed leg length. A
  // one-shot press settles a few units short of its own target, where it balances
  // the gravity sag, and those few units are the difference between standing on your
  // feet and hanging off your arms. Costs plant rate above ~1.1: the body stands
  // taller, and holds that were a comfortable distance from the shoulder come in too
  // close for canReach.
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
  // How long the escape may keep pushing at one set of holds before giving up on it.
  // Some stances have a better global answer that the local relaxation simply refuses
  // to hold, and then the two solvers take turns forever -- measured as a 9Hz twitch
  // that never ended. A second is generous on purpose: the urgency scaling above is
  // what actually stops the twitching, and a budget tight enough to matter there
  // (0.35s) cut short genuine recoveries in `npm run fuzz` and tripled its failures.
  WEDGE_BUDGET: 1.0, // seconds, per stance
  WEDGE_REARM: 0.25, // budget recovered per second of clean time, as a rate
  // Applied once per substep (see applyDragPull), multiplying how far the pointer is
  // past the lunge line. This is a stability limit, not a taste knob: the anchor
  // takes ~3/4 of the move, so past an effective gain of 1 the body overshoots the
  // line, and past ~2 it overshoots by more than it was short, which rings. Measured
  // over 200 moves x 5 levels, plant rate plateaus at 2.0 (94%) and everything above
  // buys chatter -- 0 bouncing windows at 2.0, 2 at 3.0, 53 at 6.0.
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

  // ----------------------------------------------------------- off balance ---
  // WITH NO HAND ON THE WALL YOU ARE STANDING, NOT HANGING, and the centre of
  // mass has to sit over your feet. Nothing else in the solver knows this: the
  // constraints are distances and cones, and no part of the model has ever
  // computed a moment. So two fingers could haul both hands off and hold the body
  // out horizontally past its feet indefinitely -- measured as a genuine
  // equilibrium, settling 75u outside the foot span at 0.00u of violation, with
  // the only consequence a stamina drain that took 10.2 seconds to bite.
  //
  // The base-of-support idea was rejected once already (see docs/BRIEF.md) and
  // that rejection was right: a support polygon is a floor concept, and with a
  // hand on the wall you are hanging, so 43% of real route stances legitimately
  // put the COM outside the foot span (p90 17u, max 44u). But with NO hand on,
  // the footholds *are* the floor and the polygon is exactly the right idea. That
  // is why all of this is scoped to the no-hands case -- where, measured over all
  // thirty problems, 0 of 1112 route stances ever land, so none of it can touch
  // generated climbing, the plant rate or the strain calibration.
  //
  // Past the base the body is pulled back over its feet. Note that this is the
  // CLIMBER'S OWN EFFORT, not gravity: gravity's moment out there is
  // destabilising and would rotate you further off, which is the honest physics
  // and makes every overbalance fatal. Recovering instead means an overreach
  // simply fails to come off, which is the forgiving reading and the right one
  // for a toy about how dragging feels.
  TOPPLE_MARGIN: 10, // free lean past the edge of the foothold, world units
  // Proportional to the overhang and zero exactly at the edge, so it has a real
  // equilibrium there and cannot overshoot into its own dead zone -- the lesson
  // the drag lunge taught (see LUNGE_START). Saturated for the same reason
  // FOOT_PUSH_RATE is: a huge overhang would otherwise ask for a teleport.
  TOPPLE_STIFF: 0.16, // fraction of the overhang recovered per substep
  TOPPLE_RATE: 320, // ...saturating here, world units / second
  // ...and if the player out-drags that, a budget runs out and you come off. It
  // burns proportionally to the overhang, so a small lean past the edge is
  // survivable for seconds and a big one for a fraction of one -- which is what
  // keeps a transitory lunge possible while a held pose is not. Measured on a
  // stance with the feet 45u apart and the pointers hauled off the side of the
  // wall: full stretch drops you at 0.46s, a moderate lean at 0.68s, and a lunge
  // out and back survives up to ~350ms of it.
  //
  // Note TOPPLE_MAX caps the overhang and therefore caps the burn rate too, so
  // these two knobs are not independent -- retune REF whenever MAX moves, or the
  // shortest possible fall silently gets longer. Tightening MAX 16 -> 12 on its own
  // took the full-stretch fall from 0.33s to 0.86s.
  TOPPLE_REF: 14, // overhang that burns the budget at 1x, world units
  TOPPLE_BUDGET: 0.42, // seconds of that before you come off
  TOPPLE_REARM: 1.6, // budget recovered per second back in balance, as a rate
  // ...and the hard limit, projected after the constraints have run. Past the free
  // margin the body may be dragged this much further and NO further, however hard
  // the pointer pulls -- so the lean has an end you can feel rather than a timer
  // you can't. The soft recovery above cannot do this job on its own: it loses 40:1
  // to the drag, and in any case what hauls the body out there is the pose
  // correction on a cross-body hand, which has an order more authority than either.
  // See projectBalance.
  //
  // With the margin above this puts the centre of mass at most ~22u past the outer
  // foot, which is roughly a third of a torso length -- visibly a lunge, and
  // visibly not a pose. At 16 it was 40u and still read as the plank it replaced.
  TOPPLE_MAX: 12,

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
  // Calibrated against the measured spread of real problem stances on level 1, which
  // on REF_DAY runs p25 0.23 / median 0.30 / p90 0.44. Roughly the best 35% of
  // positions on the easiest level offer a rest, falling to 5% on the hardest -- see
  // `npm run ladder`.
  //
  // With the walls reseeded daily that fraction is a distribution, not a number: it
  // runs 26-45% on level 1 across a 24-day sample, which is why REF_DAY is pinned to
  // the median day rather than to whichever one was convenient. Don't chase a day.
  //
  // That is more generous on level 1 than the old "best third of an endless wall",
  // and deliberately: a problem is 30-odd moves, so stamina is a pace to keep rather
  // than a fuel gauge to eke out, and the level that says "jugs all the way up" should
  // let you stop and look at the sequence. The bite is at the top of the ladder, where
  // a problem is a race you have to have read in advance.
  //
  // Re-measure with `npm run measure` if the strain terms change -- and note that a
  // SOLVER change moves this too: the oscillation fix left the figure standing a
  // little lower (35% of bodyweight on the arms, up from 29%), which pushed every
  // stance's strain up and would have quietly cost you a chunk of rest fraction.
  REST_STRAIN: 0.26,

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

  // How a hold is DRAWN. Purely cosmetic -- the sim still sees one quality scalar
  // (see the standing decisions in CLAUDE.md), and nothing here is read by body.js,
  // wall.js or stamina.js. What it buys is legibility: size and a colour ramp alone
  // meant every hold was the same blue circle at a slightly different diameter, and
  // reading a wall meant squinting at diameters.
  //
  // Each kind covers a QUALITY BAND, and the bands overlap deliberately. Shape has
  // to correlate with quality or it actively misleads -- quality is what drives
  // strain, so a hold that looks like a jug must be a good one. But a strict
  // one-shape-per-band mapping makes shape redundant with size and the wall reads
  // banded, so the overlaps let a given quality pick from two or three silhouettes.
  // The pick is a hash of the hold's own position, not the generator's rng, so
  // adding or retuning kinds cannot shift a single hold: wall geometry is untouched
  // and `verify` proves the same routes it did before.
  HOLD_KINDS: [
    { name: 'jug', from: 0.7, to: 1.01, col: '#5fd49b' },
    { name: 'pocket', from: 0.5, to: 0.86, col: '#57b6e0' },
    { name: 'pinch', from: 0.33, to: 0.68, col: '#9a8ce6' },
    { name: 'sloper', from: 0.17, to: 0.47, col: '#d99a5f' },
    { name: 'crimp', from: -0.01, to: 0.3, col: '#cf6f86' },
  ],

  // -------------------------------------------------------------- generator ---
  // The problems are reseeded from the local date every day (see day.js), so there
  // is no fixed set of thirty walls to measure any more. `measure`, `ladder`, `sim`,
  // `fuzz` and `jitter` therefore pin this day by default: a tuning harness whose
  // walls change overnight can't tell you what your constant did. `verify` is the
  // exception -- it sweeps the days players are actually about to get.
  //
  // The day itself is picked by measurement, not taken from a hat. A day's walls
  // vary: the rest fraction on level 1 runs 26-45% across a 24-day sample, and
  // calibrating REST_STRAIN against a day at either end would bake that day's luck
  // into a constant. This is the sample's MEDIAN day (35%), so the pinned harness
  // sits where a typical set does. Re-pick it the same way if it ever moves.
  REF_DAY: 20260812,
  // How many days of ticks to keep in localStorage. A year and a bit, at ~30 keys a
  // day, is a few tens of KB and enough for any calendar we'd want to draw.
  HISTORY_DAYS: 400,
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
  // prints this table, measured on REF_DAY's thirty problems:
  //
  //   lvl  floor  holds/100u  hold q  move  reuse  choices  stuck  rests  topped
  //    1    0.00     12.3       0.91  51.2    1%     11.0    0.21    37%    6/6
  //    2    0.20     10.2       0.77  54.9    6%      8.0    0.57    19%    6/6
  //    3    0.45      8.7       0.60  57.7   11%      8.2    0.38    13%    6/6
  //    4    0.70      7.2       0.46  62.6   18%      6.5    0.69     4%    5/6
  //    5    1.00      6.0       0.29  69.3   24%      4.7    0.97     5%    5/6
  //
  // `choices` is how many legal moves a stance offers and `stuck` how many of the
  // four limbs have none. Level 5 averages nearly one limb with nowhere to go,
  // which is the point: you have to work out which limb can move, and in what
  // order. Note the auto-climber never rests deliberately, so a human gets
  // further -- these are for spacing the rungs, not for predicting scores. The
  // `climbed` column the table used to carry is gone: every problem is about the
  // same height now, so it is flat by construction.
  //
  // These are ONE DAY's walls. The set is reseeded from the date daily, so each
  // column is a sample and not a constant -- level 1's rest fraction alone runs
  // 26-45% across a 24-day sample. Compare like for like (same day) when a change
  // moves one of these, or the day's luck reads as your change.
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

  // ------------------------------------------------------------- problems ---
  // Each level holds this many separate boulder problems, and a problem is SHORT:
  // it ends at a finish hold you have to match with both hands. The wall used to be
  // effectively endless (600 moves, ~8500u) and that made it a marathon -- you never
  // saw the end of one, so there was nothing to solve, only somewhere to get tired.
  // A problem is about four body lengths, which fits most of a phone screen and can
  // be read as a whole before you start pulling.
  PROBLEMS_PER_LEVEL: 6,
  PROBLEM_RISE: 430, // world units of climbing before the generator looks for a top
  PROBLEM_MOVE_CAP: 90, // stop asking if a problem somehow won't finish
  // Re-rolls allowed when the generator's walk dead-ends and the problem comes out
  // with no top-out. One walk in ~1800 does; four independent re-rolls put that at
  // roughly one in 10^13, which is the right order for a defect that would hand
  // somebody an unwinnable problem on a device nobody can run `verify` on.
  PROBLEM_RETRIES: 4,
  TOP_TRIES: 26, // candidate finish positions tried per attempt
  // Both hands on the finish hold, held for this long, tops the problem. The delay
  // is the bouldering rule -- you have to *control* the top, not slap it -- and it
  // also stops a wobble through the hold registering as a send.
  TOP_HOLD_TIME: 0.6,
  TOP_LINGER: 1.1, // seconds of celebrating before the menu comes back

  // The styles a problem can be built in. `moves`/`drift`/`dist` multiply the
  // generator's usual asks; `feature` is a required move the route must contain.
  //
  // A style is a *shape*, not a second difficulty system: every one of them is
  // generated at its level's floor and proven the same way, so PROJECT/traverse is
  // still a level-5 wall. What changes is what the sequence asks you to do.
  STYLES: [
    { id: 'up', name: 'UP', blurb: 'straight up', rise: 1.0, drift: 1.0, dist: 1.0 },
    {
      id: 'traverse',
      name: 'TRAVERSE',
      blurb: 'sideways, then up',
      rise: 0.55,
      drift: 1.0,
      dist: 1.0,
      cross: 0.36, // aim this far off centre, as a fraction of the wall width
      pull: 0.62, // ...and commit to it, rather than drifting
    },
    {
      id: 'footmatch',
      name: 'MATCH',
      blurb: 'both feet, one hold',
      rise: 0.85,
      drift: 1.0,
      dist: 1.0,
      feature: 'footmatch',
    },
    { id: 'reachy', name: 'REACHY', blurb: 'long moves', rise: 1.0, drift: 1.0, dist: 1.22 },
    {
      id: 'wander',
      name: 'WANDER',
      blurb: 'weaves across the wall',
      rise: 0.8,
      drift: 2.2,
      dist: 1.0,
    },
    { id: 'tall', name: 'TALL', blurb: 'a longer one', rise: 1.45, drift: 1.0, dist: 1.0 },
  ],

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
    // Fallback only -- a hold's colour comes from its kind (HOLD_KINDS).
    holdGood: '#5fb3d4',
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
