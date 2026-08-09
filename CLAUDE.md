# CLAUDE.md

Prototype 2D bouldering game. Drag a stick figure's hands and feet onto holds to
climb. Target is **iPhone Safari, portrait**; desktop is for development only.

Read [docs/BRIEF.md](docs/BRIEF.md) before making design decisions — it defines
scope and intent, and it wins over anything inferred from the code.

**The prototype exists to answer one question: does dragging limbs around a wall
feel good?** Work that doesn't serve that is out of scope. Explicitly not wanted
yet: visual polish, art, sound, menus, scoring, progression, seed entry, level
select, or difficulty tuning beyond rough placeholders.

## Where things stand

Working and verified: draggable limbs with multitouch, reach limits with body
lunge, anatomical pose limits, geometric load distribution, stamina with rest and
recovery, falling, scrolling camera, and seeded walls that are climbable by
construction. Frame cost ~0.3ms of a 16.7ms budget.

Standing decisions, so they don't get relitigated by accident:

| Decision | Status |
|---|---|
| **No depth axis.** The sim is 2D *in the wall plane*, so "hips in close to the wall" cannot be represented and true barn-dooring (which rotates out of plane) is not modelled. | Settled — deliberate |
| **One global stamina bar**, though strain is computed per limb internally. Per-limb pump, and shaking out one arm, is a small step from here. | Deferred |
| **Holds are a direction-free quality scalar.** No underclings, sidepulls or slopers that only work when pulled a particular way. | Deferred |
| **Nothing peels off a hold automatically.** Planted limbs limit reach; the player taps a limb to release it. | Settled — replaced auto-peel |
| **Tap-to-release applies to hands too**, not only feet. | Settled, but flagged: a mistimed tap on a hand can drop you |

The brief in `docs/BRIEF.md` has been revised where playtesting proved it wrong;
its Revisions section records what changed and why.

## Commands

```bash
npm run dev      # Vite dev server on :5173, bound to 0.0.0.0
npm run verify   # prove generated walls are climbable (static solve)
npm run sim      # headless auto-climber (live solver): plant rate, jitter, invariants
npm run measure  # what the biophysics model actually does, in numbers
```

`verify` and `sim` answer "is it broken?"; `measure` answers "what does it do?".
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
| `src/render.js` | canvas drawing |
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

and finally `projectReach` enforces reach + pose + torso strictly, so the
envelope gets the last word.

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

It's calibrated against the measured spread of **real route stances** (currently
p25 ≈ 0.28, median ≈ 0.37, p90 ≈ 0.69), so about the best quarter recover.
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

Each route hold records which limb moved to it (`hold.limb`), which is what lets
`routeStances()` replay the route for verification.

Both checks matter and they check different things:

- `npm run verify` — re-proves every route stance statically, across many seeds.
  Catches a retune of the reach constants silently making walls unclimbable.
- `npm run sim` — replays those same routes through the live per-frame solver.
  Catches oscillation, failed grabs, and dynamic/static mismatch.

Expect ~92–96% per-move plant rate from `sim`. It drags for a fixed 0.18s and
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
are *possible*, never that they're good. It averages ~35% of bodyweight on the
arms across a route, and it never tries to put the feet under the body, which is
why rests are scarcer than they should be and why `REST_STRAIN` has to sit so
high. Teaching `stanceFeasible` to *prefer* low-arm-load stances (rather than
merely accept any feasible one) is the highest-value change available.

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
or set `__game.debug = true`. The `dbg` button (or `D`) shows the strain
breakdown, the per-limb load shares, per-frame update/render cost, and the centre
of mass. `R` restarts.

Frame cost is ~0.3ms of a 16.7ms budget, so if the browser reports a low fps it's
throttling, not the game — check `msUpdate` / `msRender` before optimising.

Note that `requestAnimationFrame` gets throttled when the browser pane isn't
focused, which makes rAF-driven browser automation flaky. Prefer `npm run sim`
for anything measurable — the physics modules are pure and run headless in Node.
