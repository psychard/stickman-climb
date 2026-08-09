# CLAUDE.md

Prototype 2D bouldering game. Drag a stick figure's hands and feet onto holds to
climb. Target is **iPhone Safari, portrait**; desktop is for development only.

Read [docs/BRIEF.md](docs/BRIEF.md) before making design decisions — it defines
scope and intent, and it wins over anything inferred from the code.

**The prototype exists to answer one question: does dragging limbs around a wall
feel good?** Work that doesn't serve that is out of scope. Explicitly not wanted
yet: visual polish, art, sound, menus, scoring, progression, seed entry, level
select, or difficulty tuning beyond rough placeholders.

## Commands

```bash
npm run dev      # Vite dev server on :5173, bound to 0.0.0.0
npm run verify   # prove generated walls are climbable (static solve)
npm run sim      # headless auto-climber (live solver): plant rate, jitter, stamina
```

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
fall out for free. Each substep relaxes a small constraint set in this order
(Gauss-Seidel: later constraints win):

1. dragged limbs **pull** the body toward the pointer — this is the lunge
2. planted feet **push** the body up off their hold (legs are struts, one-sided)
3. planted limbs clamp the body inside their reach envelope — **hands both ways,
   feet only in compression**
4. **pose cones** keep each limb anatomically plausible relative to the torso
5. torso keeps its length
6. weak bias keeps the chest above the hip

A dragged limb never stretches past max reach. The pointer pulls the *body*, and
if the body can't get there the grab fails. Visual elasticity past max is capped
by `REACH_STRETCH` and is cosmetic — `canReach()` is the real gate.

### Hands hold you on; feet only hold you up

A hand is a tension anchor — hanging off one is the whole point. A foot is a
*conditional* contact: it can push but never pull, so it drops off the hold when
either condition fails. Over-extend the leg past `FOOT_PEEL_SLACK`, or drag the
foot more than `POSE_PEEL` outside its cone, and the foot peels. Feet used to
tether like hands, which meant you could hang from your feet.

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

Strain is one scalar built from four terms, and `REST_STRAIN` is the threshold
between draining and recovering — the whole pacing mechanic is that one number.
It's calibrated against the measured spread of real route stances (p25 ≈ 0.32,
median ≈ 0.41, p90 ≈ 0.73) so roughly the best quarter of positions offer a rest.
**Re-measure that spread before changing it**; the idealised stances in a test
harness score far lower than anything the generator actually produces.

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

Expect ~96–98% per-move plant rate from `sim`. It drags for a fixed 0.18s and
releases blind; a human holds until the target ring highlights, so real success
is higher. A large drop means something regressed. `sim` also asserts the
anatomical invariants — feet never loaded in tension past the peel slack, limbs
inside their cones, joints not snapping sides — so those can't silently rot.

**Known gap:** the generator only checks stances are *possible*, not that they're
good. It averages ~47% of bodyweight on the arms across a route, which is why
rests are scarcer than they should be. Teaching it to prefer stances with the
feet under the body is the obvious next step.

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
breakdown, per-frame update/render cost, and the centre of mass against its base
of support. `R` restarts.

Note that `requestAnimationFrame` gets throttled when the browser pane isn't
focused, which makes rAF-driven browser automation flaky. Prefer `npm run sim`
for anything measurable — the physics modules are pure and run headless in Node.
