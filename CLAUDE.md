# CLAUDE.md

Prototype 2D bouldering game. Drag a stick figure's hands and feet onto holds to
climb. Target is **iPhone Safari, portrait**; desktop is for development only.

Read [docs/BRIEF.md](docs/BRIEF.md) before making design decisions — it defines
scope and intent, and it wins over anything inferred from the code.

**The prototype exists to answer one question: does dragging limbs around a wall
feel good?** Work that doesn't serve that is out of scope. Explicitly not wanted
yet: visual polish, art, sound, scoring, progression, or seed entry.

A menu with five difficulty levels *was* on that not-wanted list and was added on
request, because one wall at one difficulty couldn't answer the question — the
original wall has so many good holds that route-finding is trivial. See
[Menu and difficulty](#menu-and-difficulty).

## Where things stand

Working and verified: draggable limbs with multitouch, reach limits with body
lunge, anatomical pose limits, geometric load distribution, stamina with rest and
recovery, falling, scrolling camera, seeded walls that are climbable by
construction, and a level menu with five difficulties. Frame cost ~0.3ms of a
16.7ms budget.

`sim` passes all five levels over the full 400-move route, and `fuzz` — which
hauls three limbs at once to arbitrary points — leaves a settled violation in
1 run out of 300. Both were comprehensively red before the solver pass described
in [Keeping the body physical](#keeping-the-body-physical).

Standing decisions, so they don't get relitigated by accident:

| Decision | Status |
|---|---|
| **No depth axis.** The sim is 2D *in the wall plane*, so "hips in close to the wall" cannot be represented and true barn-dooring (which rotates out of plane) is not modelled. | Settled — deliberate |
| **One global stamina bar**, though strain is computed per limb internally. Per-limb pump, and shaking out one arm, is a small step from here. | Deferred |
| **Holds are a direction-free quality scalar.** No underclings, sidepulls or slopers that only work when pulled a particular way. | Deferred |
| **Nothing peels off a hold automatically.** Planted limbs limit reach; the player taps a limb to release it. | Settled — replaced auto-peel |
| **Tap-to-release applies to hands too**, not only feet. | Settled, but flagged: a mistimed tap on a hand can drop you |
| **Difficulty is one scalar.** A level sets a *floor* under the same easy→hard number the height ramp already drives; there is no second difficulty system. | Settled |
| **Falling returns to the menu**, carrying the reason and height with it. There is no separate retry screen. | Settled |

The brief in `docs/BRIEF.md` has been revised where playtesting proved it wrong;
its Revisions section records what changed and why.

## Commands

```bash
npm run dev      # Vite dev server on :5173, bound to 0.0.0.0
npm run verify   # prove generated walls are climbable (static solve), all 5 levels
npm run sim      # headless auto-climber (live solver): plant rate, jitter, invariants
npm run measure  # what the biophysics model actually does, in numbers
npm run ladder   # are the five levels actually five difficulties?
npm run fuzz     # haul 3 limbs at once to absurd places; can the body be broken?
```

`verify`, `sim` and `fuzz` answer "is it broken?"; `measure` and `ladder` answer
"what does it do?". `sim` plays cooperatively and `fuzz` plays adversarially, and
they catch different things — the whole multi-limb-drag regime was unmeasured
until `fuzz` existed, and it was badly broken.
Several constants in `tuning.js` cite measured numbers — **if you change a strain
term, a load rule or a reach constant, run `measure` and update whatever you
invalidated**, here and in the tuning comments. The numbers below were last
refreshed from it.

Testing on a phone is via `ngrok http 5173`. `vite.config.js` sets
`server.allowedHosts` for ngrok domains — Vite rejects unknown `Host` headers, so
removing those entries makes the tunnel 502 while localhost keeps working.

## Layout

| File | Role |
|---|---|
| `src/tuning.js` | **every** tuning constant, plus the palette |
| `src/body.js` | figure model + constraint solver (the core of the feel) |
| `src/wall.js` | seeded generation, climbability proof, spatial index |
| `src/stamina.js` | load distribution + the drain factors, as one `strain` scalar |
| `src/game.js` | state, camera, drag interaction |
| `src/render.js` | canvas drawing, the HUD, and the level menu |
| `src/input.js` | Pointer Events plumbing |
| `src/main.js` | canvas sizing, safe-area insets, frame loop |

Tuning constants live **only** in `src/tuning.js`. Don't inline magic numbers in
the other modules; they get adjusted constantly and need to be in one place.

## How the figure works

The body is two points — `hip` and `chest` — held apart by a fixed torso length.
Shoulder and hip sockets are derived from those two, so torso lean and rotation
fall out for free.

Gravity **and the drag lunge** are applied once per substep as external
displacements. Then the constraints are relaxed, in this order (Gauss-Seidel:
later constraints win):

1. planted feet **push** the body up off their hold (legs are struts, one-sided)
2. planted limbs clamp the body inside their reach envelope
3. **pose cones** keep each limb anatomically plausible relative to the torso
4. torso keeps its length
5. weak bias keeps the chest above the hip

then `projectReach` enforces reach + pose + torso strictly, followed by
`REACH_FINAL_PASSES` reach-only sweeps so the envelope genuinely gets the last
word. `escapeWedge` runs *before* the relaxation and is what gets the body out of
a bad local minimum. See [Keeping the body physical](#keeping-the-body-physical).

**Apply the drag once per substep, never inside the relaxation loop.** A soft
constraint re-applied every iteration always beats a hard one it opposes: the
lunge kept re-injecting exactly the violation the reach clamps were removing, and
they settled at a permanent ~8 units of over-extended leg that was completely
independent of drag strength or drag duration. Same reason `projectReach` exists
and runs last — enforcing reach on its own can shove the body out of a limb's
pose cone, so the two have to be projected together or they trade the violation
back and forth forever.

Because the constraints now get the last word, `DRAG_PULL` wants to be *large*
(6.0, not 0.3): the body reaches the boundary its planted limbs allow within a
substep and stays there, instead of lagging mid-migration. Raising it took plant
rate 75% → 93% while *reducing* peak leg stretch.

A dragged limb never stretches past max reach. The pointer pulls the *body*, and
if the body can't get there the grab fails. Visual elasticity past max is capped
by `REACH_STRETCH` and is cosmetic — `canReach()` is the real gate.

### The lunge needs two thresholds

`LUNGE_START` / `LUNGE_SETTLE`, both fractions of the limb's max reach, and the
pair of them is load-bearing:

- Lunging from the limb's *preferred* length means **every** reach hauls the body
  along. Reaching overhead then lifts the body, both legs run past their length,
  and both feet peel at once — you end up hanging off one hand for no reason the
  player did anything to deserve. Only lunge for what the limb genuinely can't
  reach (`LUNGE_START: 1.0`).
- But pulling only the *shortfall* stops the body the instant the hold sits at
  exactly max reach, so the stance lands on a knife edge and the settle that
  follows pushes it straight back out of range. Plant rate fell to ~65% and no
  amount of stiffness fixed it, because stiffness isn't the bottleneck — the
  target is. `LUNGE_SETTLE` pulls to comfortably inside reach instead.

`DRAG_LIFT` separately damps the upward component: leaning sideways is nearly
free, hauling yourself upward is muscular work. A hold far above your max reach
is therefore genuinely unreachable, which is what the brief asks for.

Reaching in any direction, at any distance, must leave both feet on the wall.
`sim` asserts `peels` (0), `solo` (frames on a single contact, 0%), `noFeet`
(0%), and `legStretch` settled (< 1u). It reports stretch *while pulling*
separately — elastic give under load is the intended feel, a leg left stretched
once the stance settles is not.

### A planted limb limits you; nothing peels by itself

**Nothing ever comes off a hold automatically.** A planted limb is a strut of
fixed maximum length, so it caps how far the body can travel — reaching too far
simply doesn't happen, rather than ripping a foot off the wall. If the player
wants the extra reach they **tap a limb to release it** (a touch that never
travels past `TAP_SLOP`), and then have to hold the position on what's left.
Releasing a trailing foot buys ~8 units of lateral reach.

Auto-peeling was tried and removed: reaching would silently strip your feet off
and leave you hanging from one hand, which reads as the game breaking rather than
as a mistake you made.

For a foot the limit is **kinematic, not tension** — your leg is only so long.
This is only safe because the pose cones exist. Max-reach clamps on feet with no
cone let you dangle below a foothold, hanging from your feet; the cone caps a
foot at `POSE.FOOT_RISE` above the hip, so that geometry is forbidden outright
and gravity can only ever *compress* a leg whose foot is beneath you. Leg
extension is always voluntary. The load model separately gives a foot ~0 share
unless it's genuinely underneath the COM, so a limiting leg isn't a supporting
one.

Pose cones live in the torso frame (`limbPose`): `up` toward the head, `out`
sideways on the limb's own side. Without them a limb is a pure distance
constraint, legal anywhere on a ring around its socket — which is how a foot
ended up above the chest. The same predicate gates three places, and all three
matter: `canReach` (you can't grab it), the solver (you can't drift into it), and
`stanceFeasible` (routes never demand it).

### Two solver traps, both already hit

**Gravity is positional while you're on the wall, not an acceleration.** The body
sags by `GRAVITY_SAG * dt` each substep and the tethers arrest it. Real gravity
plus stiff constraints stores kinetic energy the solver then has to dissipate,
and the figure vibrates. Only free-fall (`fig.falling`) uses real dynamics.

**Physics substeps must be whole.** `game.accum` carries leftover time to the
next frame. Running a short final substep is catastrophic because the solver
derives velocity as `delta / dt` — a 0.3ms timestep turns a rounding-sized
position delta into a 2000 unit/s impulse and the figure explodes into a spring.
If it ever starts skittering again, check this first.

`npm run sim` guards both: it fails the run if an idle hanging figure travels
more than ~1 world unit over 120 substeps.

### Keeping the body physical

Four things stop the figure being dragged into shapes a body cannot make. Each
was found by measurement, and `npm run fuzz` is what holds them in place: it
grabs up to three limbs at once and hauls them to arbitrary points, which is what
a player does when poking at the toy and which nothing else exercises. Before this
pass it produced a 208u leg, an inverted torso and 180u pose violations.

**The drag pull was unbounded.** `DRAG_PULL` multiplies the *shortfall* between
the pointer and the limb's reach, so dragging to three times a limb's length asked
for ~880 units of body travel in one 1/120s substep. Instrumenting the substep
showed a planted foot 555u out of reach immediately after the drag and 0u after
projection — the constraints usually recover, but from some configurations they
cannot, and that is where the rubber limbs came from. `DRAG_MAX_STEP` caps it, on
the *body* rather than per pointer: there is one body and it has one speed limit,
so three fingers cannot haul it three times as fast.

**Pose was measured against the raw pointer.** The correction is proportional to
how far outside the cone a point sits, so a pointer flung across the wall shoved
the body by that distance at full strength, every pass, and the reach clamps could
not win. `poseTarget()` keeps the direction — pointing across your body should
still rotate the torso — but limits the distance to somewhere the limb could go.

**The torso could inverte.** `UPRIGHT_STIFF` is a 0.012 bias and a hard drag
overwhelms it trivially. That matters far more than it looks: the pose cones live
in the torso frame, so once the chest passes under the hip every anatomical limit
mirrors, and the cones start holding the figure in impossible shapes instead of
out of them. `enforceTilt` caps tilt at `TORSO_TILT_MAX` hard. Normal play reaches
46 degrees against a 72 degree cap, so it never binds in ordinary climbing.

**Reach did not actually get the last word**, despite the comment saying so. Every
projection pass ends with pose, torso and tilt, all of which move the body *after*
the clamps ran, so a planted limb could be left over-stretched however many passes
it got. `REACH_FINAL_PASSES` re-closes the envelope at the end with only the torso
kept valid alongside it. Over-stretch is the violation that reads as broken, so it
wins the tie — and measured over 250 moves x 4 seeds this *raised* plant rate
(L5 90.3% -> 91.4%), so it is not a trade against reachability.

### You cannot enter a stance that has no solution

`canReach` only asks whether one limb can reach one hold from where the body is
now. That is not enough. Plant four limbs one at a time, each legal when taken,
and the body moves between grabs until the combination is one **no body can
hold** — `solveStatic` returned an 84.7u violation on a stance reached by
dragging, and its answer was identical to the live body's, so there was nothing
left for the solver to fix. The figure was drawn with a 99u leg and a foot up by
its head because that genuinely was the best available answer.

So planting is gated on `stanceSolvable()`, the same way the generator gates
placing a hold. This keeps the invariant that the current stance always has a
solution, which holds inductively: releasing a limb only removes constraints, and
dragging moves the body but not the holds. It is `stanceSolvable` and not
`stanceFeasible` because the crossed-limb and hands-above-feet rules are the
generator's taste and shouldn't veto what a player does deliberately.

### The wedge escape

The relaxation is local and path-dependent, so it still has more than one stable
answer per stance and can settle in a bad one — typically the torso leaning the
wrong way, which reads every cone mirrored. It is a fixed point, not slow
convergence: unchanged after 1.33s of settling, and unaffected by more passes.

`solveStatic` seeds from the hold centroids rather than the current body, so it
finds the *global* answer. `escapeWedge` uses that: past `WEDGE_TRIGGER` of
violation, with nothing being dragged, the body migrates toward it. Two details
are load-bearing, both learned the hard way:

- It is applied **before** the relaxation, as an external displacement alongside
  gravity and the drag. Nudging the body afterwards is simply undone by the next
  substep's solve, which pulls straight back into the same wedge.
- It **rotates** the torso rather than interpolating its two ends. The wedged
  answer and the good one are usually mirrored, and lerping the endpoints between
  those passes through a zero-length torso, which `enforceTorso` then re-expands
  back into the wedge. Rotating is the motion that actually gets there.

It fires often (26k times in a fuzz run, ~99% of them finding a better answer),
so don't assume it is a rare safety net — it is part of how the body settles.

**Two-bone IK has its own two traps**, both in `ikJoint`. Normalise by the TRUE
distance — clamping the length first and then dividing leaves a direction vector
longer than unit exactly when the limb is at full extension. And the bend side
must be sticky (`limb.bend`): choosing it fresh each frame from a dot product
against the torso's right vector flips whenever the limb points sideways and the
dot passes through zero, so knees snap between IK solutions mid-move.

## Stamina and load

Strain is one scalar built from four terms — hold quality, flexion, balance, and
arm load — and `REST_STRAIN` is the threshold between draining and recovering.
The whole pacing mechanic is that one number.

It's calibrated against the measured spread of **real route stances** on level 1
(currently p25 ≈ 0.27, median ≈ 0.36, p90 ≈ 0.59), so about the best third
recover. Harder levels are deliberately worse: `ladder` reports rests falling from
44% of stances on level 1 to 4% on level 5.
`npm run measure` prints that spread and the resulting recover fraction. Always
calibrate against it rather than against idealised stances: a clean test-harness
stance scores ~0.12, far below anything the generator actually produces, and
tuning to that makes rest impossible on a real wall.

Load distribution is the part that makes technique matter. Each contact's share
of bodyweight comes from how well it opposes gravity and how near the COM sits
to it — so getting your hips over your feet genuinely unloads your arms (~80% on
the feet in a good stance, vs 100% on the arms in a dead hang). Watch the `load`
row in the debug overlay.

Three things about the model that are counterintuitive and were each a bug once:

- **Flexion costs, not extension.** A straight arm hangs off bone and is nearly
  free; the locked-off arm burns. Same for legs. The reverse rule penalises good
  technique.
- **y grows downward,** so "COM above the foot" is `hold.y - com.y`. Getting this
  backwards silently zeroes out all foot load.
- **Balance is horizontal only.** Gravity destabilises you sideways; vertically
  it just hangs you plumb. Measuring perpendicular distance from the contacts'
  principal axis — the obvious way to write "barn door" — scores a dead hang as
  maximally unstable, when it's the most stable thing on the wall. Real
  barn-dooring rotates out of the wall plane and we don't model depth.

## Wall generation

Holds are not scattered and hoped over. The generator walks a virtual climber up
the wall one limb at a time and only commits a hold if `stanceFeasible()` — which
runs the **actual body solver** headlessly — says the resulting four-point stance
is holdable. Route holds are therefore a proven-climbable ladder by construction;
filler holds are decoration and alternates.

Each move first tries to land on a hold that already exists (`pickReusable`) and
only invents a new one if none works, which is what keeps hard walls sparse — see
[Menu and difficulty](#menu-and-difficulty). The guarantee is unaffected: a reused
hold goes through the same feasibility check as a fresh one.

**The route is `wall.route`, an ordered list of `{ limb, hold }` moves** — not the
holds array. It used to be reconstructed by filtering `holds` and reading a
`hold.limb` back off each one, which only worked while every move placed exactly
one new hold. Hold reuse broke that: a hold can serve several moves, by different
limbs, at different times. `routeStances()` and `moveDistances()` both replay the
move list, and anything measuring the route must do the same.

Both checks matter and they check different things:

- `npm run verify` — re-proves every route stance statically, at every level and
  starting with the seed the menu actually serves for it. Catches a retune of the
  reach constants silently making walls unclimbable.
- `npm run sim` — replays those same routes through the live per-frame solver.
  Catches oscillation, failed grabs, and dynamic/static mismatch.

`sim` used to stop when the harness pumped out, which on level 5 was move 44 --
far too few for a 90% plant-rate assertion (one extra miss moves it 2%) and it hid
the wedge bug entirely. It now walks the whole route and reports `pumpedAt`
separately. Plant rate over 250 moves x 4 seeds is the number to trust.

Expect ~91–96% per-move plant rate from `sim`. It drags for a fixed 0.18s and
releases blind; a human holds until the target ring highlights, so real success
is higher. A large drop means something regressed.

`sim` also asserts the anatomical invariants so they can't silently rot: nothing
peels (`peels` 0), you're never reduced to one contact (`solo` 0%), never with
both feet off (`noFeet` 0%), legs aren't left stretched once settled, limbs stay
inside their cones, and joints don't snap sides.

One thing to know when reading `sim`: on a missed grab it force-plants the
intended hold to resync to the route, otherwise a single marginal failure
cascades and every later target is measured from the wrong place. Those synthetic
stances are excluded from the anatomical invariants (`watch.synthetic`) — the
figure never actually achieved them, so asserting on them measures the harness.

**Known gap — the obvious next piece of work.** The generator only checks stances
are *possible*, never that they're good. It averages ~29% of bodyweight on the
arms across a route, and it never tries to put the feet under the body, which is
why rests are scarcer than they should be and why `REST_STRAIN` has to sit so
high. Teaching `stanceFeasible` to *prefer* low-arm-load stances (rather than
merely accept any feasible one) is the highest-value change available.

## Menu and difficulty

The state machine is `menu → building → climbing → falling → menu`. The menu
loads first, so **`game.wall` and `game.fig` are null until a level is picked** —
both the update and the draw path have to tolerate that. Falling goes back to the
menu after `FALL_LINGER`, carrying `game.last` (level, reason, height) so the list
doubles as the fall screen; there is no separate retry overlay any more.

`building` is a real state and not ceremony: generating a wall runs the body
solver a few thousand times (~230ms on a laptop, worse on a phone). Generating
inside the tap handler freezes the menu mid-tap and reads as a dropped tap, so the
tap only sets state and `update` waits for the "building" frame to be presented
before calling the generator.

The menu is canvas-drawn like the rest of the HUD, hit-tested against
`menuRects(view)`. Layout is derived from the view, not a design size, so the same
code works in a phone column and a letterboxed desktop window — and drawing and
hit testing read the same rects, so they cannot disagree.

**A level is one number.** `T.LEVELS[i].floor` is a floor under the same easy→hard
scalar the height ramp already drives (`difficultyAt(height, floor)`), so it moves
hold quality, filler density and move distance together. Level 1 is floor 0, i.e.
the wall the prototype had before the menu — its route geometry is bit-identical,
because move distance is untouched and only quality and filler changed.

`npm run ladder` is the tool that justifies the spacing, and the table in
`tuning.js` is its output — regenerate it if you touch `LEVELS`, `MOVE_DIST`,
`QUALITY_*`, `REUSE*`, `FILL_DENSITY`, `DIFF_FULL_HEIGHT`, or anything that moves
strain. Currently the auto-climber gets 2107/1728/1442/1074/894u up the five levels.

The column to watch is **`choices`**: how many legal moves a stance offers, and
`stuck`, how many of the four limbs have none at all. That is the difference
between a staircase and a problem — on level 5 an average stance offers 4 moves
and more than one limb has nowhere to go, so there may be no right-hand move until
the right foot has moved, and none for that until the left foot has. Ordering is
the puzzle. Level 1 offers 11.0 moves a stance, where any order works.

**Move distance is not the difficulty lever it looks like.** `MOVE_DIST` ramps
52 → 84 across the ladder but the *achieved* move only goes 62 → 69, because a
limb move is capped by anatomy (`ARM.max` 68, `LEG.max` 80) and the feasibility
check refuses anything longer. Asking for longer moves just costs plant rate.

**Sparseness comes from hold reuse, and nothing else.** While the generator placed
one new hold per limb move, density was pinned near 9.5 holds per 100u whatever
else you tuned — a limb can only move so far, so the holds it needs arrive at a
fixed rate. `T.REUSE` lets a move land on a hold that already exists, which breaks
that link: density now runs 9.0 → 4.2 per 100u across the ladder.

Reuse is a **feet-only** mechanism in practice, and that's structural rather than
a tuning failure. The hands are the top of the route, so nothing exists above them
to move onto — a hand's candidate pool is empty on 100% of attempts. Feet succeed
about 80% of the time, stepping onto holds placed for hands a body-length earlier,
which is exactly what real climbing does. So total reuse tops out near 40%, and
~0.5 new holds per move (one per hand move) is this generator's floor.

Letting a hand **match** onto the other hand's hold was tried, to give hands
something to reuse. It backfires: hanging both hands on one hold leaves an awkward
stance, the next move backs off (`backoffs` 5 → 99), each move climbs less, and
the wall ends up with *more* holds. Don't re-try it without fixing that first.

The hard ends of `QUALITY_ROUTE` and `QUALITY_FILL` were widened (0.3 → 0.1 and
0.12 → 0.04) when the levels went in. At the old values the top three rungs
collapsed onto each other — the auto-climber reached 1103/1008/1015u, i.e. levels
4 and 5 were the same difficulty.

## Coordinates

y grows **downward** (canvas convention). Ground is `y = 0`; climbing goes
negative, so displayed height is `-y`. The wall is `WALL_W` units wide and maps
to the play column, so gameplay is identical at any screen size. On desktop the
column is letterboxed to `MAX_PLAY_W` and centred — `view.ox` is its left edge,
and screen/world conversion must account for it.

## iOS specifics

`touch-action: none`, `overscroll-behavior: none`, preventDefault on the pointer
and touch streams, and swallowed `gesture*` events. Without these Safari turns a
two-finger drag into a pinch-zoom or a pull-to-refresh mid-move.

Sizing is resize-driven off a `position: fixed; inset: 0` stage rather than
CSS-height-driven, so the dynamic toolbar just resizes the backing store. Safe
area insets are read from the `#safe-probe` element, since `env()` is CSS-only.

## Debugging

`window.__game` is exposed in dev — inspect `__game.fig.hip`, `__game.stam.parts`,
or set `__game.debug = true`. Note `fig` and `wall` are null while the menu is up.
The `dbg` button (or `D`) shows the strain breakdown, the per-limb load shares,
per-frame update/render cost, and the centre of mass. `R` restarts the current
level, `M` or `Escape` goes back to the menu, and the number keys jump straight to
a level from anywhere. `__game.startLevel(i)` does the same from the console, but
it needs two frames to build — and `requestAnimationFrame` throttles hard when the
browser pane isn't focused, so give it seconds, not milliseconds.

Frame cost is ~0.3ms of a 16.7ms budget, so if the browser reports a low fps it's
throttling, not the game — check `msUpdate` / `msRender` before optimising.

Note that `requestAnimationFrame` gets throttled when the browser pane isn't
focused, which makes rAF-driven browser automation flaky. Prefer `npm run sim`
for anything measurable — the physics modules are pure and run headless in Node.
