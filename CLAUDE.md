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
original wall has so many good holds that route-finding is trivial. It has since
become a grid of thirty short problems, also on request, for the same reason: an
endless wall is a marathon, and you cannot solve a sequence you never see the end
of. See [Problems](#problems) and [Menu and difficulty](#menu-and-difficulty).

## Where things stand

Working and verified: draggable limbs with multitouch, reach limits with body
lunge, anatomical pose limits, geometric load distribution, stamina with rest and
recovery, falling, scrolling camera, seeded walls that are climbable by
construction, thirty short boulder problems in six styles across five difficulties,
top-outs matched with both hands, and ticks that persist. Frame cost ~0.3ms of a
16.7ms budget.

`sim` tops out all thirty problems cleanly at an 89–96% per-move plant rate,
`fuzz` — which hauls three limbs at once to arbitrary points — leaves a settled
violation in 2 runs out of 300, and `jitter` finds a visible limit cycle in 1.3% of
the windows it watches — down from 11.3%, with settled stances now clean. All three
were comprehensively red before the solver passes described in
[Keeping the body physical](#keeping-the-body-physical) and
[Three oscillators](#three-oscillators).

Standing decisions, so they don't get relitigated by accident:

| Decision | Status |
|---|---|
| **No depth axis.** The sim is 2D *in the wall plane*, so "hips in close to the wall" cannot be represented and true barn-dooring (which rotates out of plane) is not modelled. | Settled — deliberate |
| **One global stamina bar**, though strain is computed per limb internally. Per-limb pump, and shaking out one arm, is a small step from here. | Deferred |
| **Holds are a direction-free quality scalar** *to the sim*. They are now *drawn* as five kinds (jug, pocket, pinch, sloper, crimp) chosen from overlapping quality bands, but nothing outside `render.js` reads that. No underclings or sidepulls that only work when pulled a particular way. | Deferred (mechanically); the shapes are cosmetic |
| **Nothing peels off a hold automatically.** Planted limbs limit reach; the player taps a limb to release it. | Settled — replaced auto-peel |
| **Tap-to-release applies to hands too**, not only feet. | Settled, but flagged: a mistimed tap on a hand can drop you |
| **Letting go of both hands is a fall** (`CAME OFF`) unless the feet alone can hold you. Hanging from two feet is anatomically impossible, so there is no body position to draw. | Settled — was an unnoticed hole in "releasing is always safe" |
| **Difficulty is one scalar.** A level sets a *floor* under the same easy→hard number the height ramp already drives; there is no second difficulty system. | Settled |
| **The reach affordance is rings on the holds, not a reach envelope.** A translucent `spec.max` disc around the socket was drawn and removed: a grab is gated on `canReach` (pose cone and a minimum distance too) and the body moves under the drag, so the disc drew a boundary that was neither the real limit nor a useful one. | Settled — don't reinstate the disc |
| **Falling returns to the menu**, carrying the reason and height with it. There is no separate retry screen. | Settled |
| **A wall is a short problem with a top**, not an endless climb: ~430u, ended by matching a finish hold with both hands. Six per level, in styles (traverse, foot match, reachy...), ticked off when topped. | Settled — replaced the endless wall |
| **Two limbs may share a hold.** Always legal in the sim; now something the generator asks for, in the foot match and in every top-out. | Settled |

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
npm run jitter   # does the body ever settle into a bouncing loop?
npm run icon     # regenerate the home-screen icon and favicons (needs rsvg-convert)
```

`verify`, `sim`, `fuzz` and `jitter` answer "is it broken?"; `measure` and `ladder`
answer "what does it do?". `sim` plays cooperatively and `fuzz` plays adversarially,
and they catch different things — the whole multi-limb-drag regime was unmeasured
until `fuzz` existed, and it was badly broken.

`jitter` covers a third regime neither of them could see: a body that is *stable*
by every invariant they check, and oscillating. It watches a second of no input
after every move, and again with the pointer held still mid-reach, and reports
**wander** — path length that went nowhere — with direction reversals and the swing
per reversal. All three are needed: a body migrating to a new equilibrium travels a
long way and is fine (high wander, no reversals), and solver noise buzzes 0.2u at 15Hz
which is invisible on a phone (high wander, many reversals, no swing). The cycles
reported from play swing 2–3u. Judging by amplitude alone flags honest settling just as
loudly, which made a third of all windows look broken. See [Three oscillators](#three-oscillators).

Several constants in `tuning.js` cite measured numbers — **if you change a strain
term, a load rule or a reach constant, run `measure` and update whatever you
invalidated**, here and in the tuning comments. The numbers below were last
refreshed from it.

Testing on a phone is via `ngrok http 5173`. `vite.config.js` sets
`server.allowedHosts` for ngrok domains — Vite rejects unknown `Host` headers, so
removing those entries makes the tunnel 502 while localhost keeps working.

## Deploying

Pushing to `main` publishes to <https://climb.psychard.com/> via
`.github/workflows/pages.yml` (npm ci → `verify` → `build` → upload → deploy).
The Pages source is set to "GitHub Actions", not deploy-from-branch, so there is
no `gh-pages` branch and nothing to commit — `dist/` stays gitignored.

**The site is served at the root of its own subdomain, so there is no `base` in
`vite.config.js`** and dev, `preview` and the deployed build all agree on `/`.
That is the whole reason for the subdomain. Serving from a bare project URL
instead (`psychard.github.io/stickman-climb/`) needs `base: '/stickman-climb/'`
for the build *and* for preview — `vite preview` reports `command === 'serve'`
exactly like the dev server does, so a build-only check passes while the one
command meant to rehearse the deploy serves the built HTML at `/` and 404s every
asset. Don't reintroduce a base without that half.

To put a *different* project on its own `psychard.com` subdomain, follow
[docs/PUBLISHING.md](docs/PUBLISHING.md) — this repo is its worked example.

The domain lives in this repo's Pages settings, not in a `CNAME` file: the
Actions build type takes it from there, so `dist/` needs nothing added. DNS is a
GoDaddy wildcard `*.psychard.com → psychard.github.io`, so a second game needs
no DNS work at all — just its own custom domain in its own repo's Pages
settings. `psychard.com` is a **verified domain** on the GitHub account, which
is what stops anyone else claiming a subdomain of it; that verification is not
optional given the wildcard.

## Adding it to a home screen

The game installs as **Stickman Climb**: `public/manifest.webmanifest` plus the
icon links and `apple-mobile-web-app-title` in `index.html`. Everything under
`public/` is copied to the root of `dist/` by Vite, so the deployed paths are the
same absolute `/icon-192.png` the dev server serves — the no-`base` decision above
is what makes that true.

**On iOS the icon comes from `apple-touch-icon`, not from the manifest**, so
`public/apple-touch-icon.png` (180px) is the file that matters on the target
device; the manifest icons are for Android and desktop Chrome. The label under
the icon comes from `apple-mobile-web-app-title` and iOS truncates it around 12
characters, so "Stickman Climb" shows clipped — shorten that meta tag (and the
manifest's `short_name`) if that ever matters more than the full name does.

`npm run icon` regenerates all of it from `tools/make-icon.mjs`. The pose in the
icon is **not** a drawing: it is a four-point stance settled by the real
`stepFigure` solver and jointed by the same `ikJoint` the renderer uses, so an
anatomy change re-renders as a body the game can still make. The script prints the
settled violation and says so if the stance is strained.

Two things about it that look like oversights and aren't:

- **The PNGs are committed.** Rasterising needs `rsvg-convert`, which is not in
  CI, and adding a rasteriser to `devDependencies` to redraw a static icon on
  every deploy is a poor trade. Without it the script still writes the SVGs and
  leaves the PNGs alone.
- **Holds are plain discs in the icon**, not the five silhouettes `render.js`
  draws. At 60 CSS px a crimp and a pocket are the same three pixels, and an SVG
  emitter for five shapes would be upkeep for nothing visible. The colours still
  come from `T.HOLD_KINDS`, so the icon can't drift off-palette.

The maskable variant is the same art at 78% inside a full-bleed background, which
is what Android's circle mask wants. iOS applies its own rounding, so the square
is deliberately not pre-rounded — baking corners in would leave dark cut corners
after iOS masks it again.

### The nudge to actually install it

The menu carries a band saying *install for full-screen play*, with the share
glyph drawn inline and the literal wording of the iOS menu item. It is worth the
pixels because a home-screen launch drops Safari's toolbars, which on a phone is
a real slice of wall — and the bottom bar otherwise sits exactly where a thumb
drags a foot.

`src/install.js` is a **user-agent sniff, deliberately**, not a
`beforeinstallprompt` handler: iOS Safari does not fire that event, so the
instruction *is* the mechanism. It shows on iPhone/iPad in a browser tab and
nowhere else — installed (`navigator.standalone`, or `display-mode: standalone`)
turns it off, Android has the browser's own prompt, and macOS has no home screen.
iPadOS reports a Macintosh UA, so it takes `maxTouchPoints > 1` to tell the two
apart. The answer is memoised: it can't change without a reload.

Three things worth knowing before changing it:

- **It doesn't draw on a machine you can develop on.** `window.__installHint(true)`
  forces it on, `(null)` hands the decision back to the sniff.
- **There is no dismiss button.** Installing is the dismissal, and it only ever
  appears on the menu — never over a climb.
- **`showInstallHint(view)` gates both the layout and the draw**, and has to keep
  doing so. The band is reserved out of `menuRects`' space rather than drawn over
  the grid, but tiles clamp at `tileMin`, so under ~490 points of usable height
  the grid overflows whatever is reserved (a landscape phone already does this
  without the band) and it is hidden rather than left sitting on top of tappable
  tiles.

## Layout

| File | Role |
|---|---|
| `src/tuning.js` | **every** tuning constant, plus the palette |
| `src/body.js` | figure model + constraint solver (the core of the feel) |
| `src/wall.js` | seeded generation, climbability proof, spatial index |
| `src/stamina.js` | load distribution + the drain factors, as one `strain` scalar |
| `src/game.js` | state, camera, drag interaction |
| `src/render.js` | canvas drawing, the HUD, the level menu, and the hold silhouettes |
| `src/input.js` | Pointer Events plumbing |
| `src/install.js` | should the menu nudge you to install it to your home screen? |
| `src/main.js` | canvas sizing, safe-area insets, frame loop |
| `public/` | manifest and home-screen icons, copied verbatim to `dist/` |

Tuning constants live **only** in `src/tuning.js`. Don't inline magic numbers in
the other modules; they get adjusted constantly and need to be in one place.

## How the figure works

The body is two points — `hip` and `chest` — held apart by a fixed torso length.
Shoulder and hip sockets are derived from those two, so torso lean and rotation
fall out for free.

Gravity, **the drag lunge and the foot push** are applied once per substep as
external displacements. Then the constraints are relaxed, in this order
(Gauss-Seidel: later constraints win):

1. planted limbs clamp the body inside their reach envelope
2. **pose cones** keep each limb anatomically plausible relative to the torso
3. torso keeps its length
4. weak bias keeps the chest above the hip

then `projectReach` enforces reach + pose + torso strictly, followed by
`REACH_FINAL_PASSES` reach-only sweeps so the envelope genuinely gets the last
word. `escapeWedge` runs *before* the relaxation and is what gets the body out of
a bad local minimum. See [Keeping the body physical](#keeping-the-body-physical).

**Apply every soft input once per substep, never inside the relaxation loop.** A
soft constraint re-applied every iteration always beats a hard one it opposes: the
lunge kept re-injecting exactly the violation the reach clamps were removing, and
they settled at a permanent ~8 units of over-extended leg that was completely
independent of drag strength or drag duration. Same reason `projectReach` exists
and runs last — enforcing reach on its own can shove the body out of a limb's
pose cone, so the two have to be projected together or they trade the violation
back and forth forever.

**The foot push belongs there too, and didn't until it was measured.** It sat
inside the relaxation as its first step, so ten passes of push fought ten passes of
clamp — and on a stance with one leg at full stretch and the other deeply folded
they never reconciled: 60u of push against 60u of clamp every substep, forever.
Moving it out took two follow-ups, because ten applications had been doing real work:
`FOOT_PUSH_STIFF` went 0.22 → 0.9 to keep the same authority per substep,
`FOOT_PUSH_RATE` bounds a deeply folded leg from asking for a 10u shove, and
`FOOT_PUSH_REACH` presses slightly *past* the relaxed leg length, because a one-shot
press settles a few units short of its own target and those units are the difference
between standing on your feet and hanging off your arms.

A dragged limb never stretches past max reach. The pointer pulls the *body*, and
if the body can't get there the grab fails. Visual elasticity past max is capped
by `REACH_STRETCH` and is cosmetic — `canReach()` is the real gate.

### The lunge needs two depths, chosen by pointer speed

`LUNGE_START` / `LUNGE_SETTLE`, both fractions of the limb's max reach, and the
pair of them is load-bearing:

- Lunging from the limb's *preferred* length means **every** reach hauls the body
  along. Reaching overhead then lifts the body, both legs run past their length,
  and both feet peel at once — you end up hanging off one hand for no reason the
  player did anything to deserve. Only lunge for what the limb nearly can't
  reach (`LUNGE_START: 0.95`).
- But pulling only to that line stops the body the instant the hold sits at about
  max reach, so the stance lands on a knife edge. Half of all missed grabs were
  exactly this: the hand is drawn *on the hold* (the last units are `REACH_STRETCH`,
  which is cosmetic) while the socket is a hair too far and `canReach` refuses.
  Measured median gap from endpoint to the hold it just failed to take: 0.0u.
  `LUNGE_SETTLE` pulls comfortably inside reach instead.

**The two cannot both be live at once**, and that was the bug. A pull armed at one
line and aimed at a deeper one is a bang-bang controller: a pointer 1u out of reach
asked for 6u of body travel, the body landed 4u *inside* the dead zone where the pull
is zero, gravity walked it back out, and it fired again — 60Hz, on a fifth of stances.
So the aim and the arming line are always the same line, and only its *depth* varies:
committed to `LUNGE_SETTLE` while the pointer is actually moving, relaxed back to
`LUNGE_START` when it stops, where the pull has a real equilibrium against gravity.
Fast attack and slow release on that estimate (`LUNGE_SPEED_*`), so pausing mid-reach
doesn't drop the body out from under the grab you're lining up.

`DRAG_PULL` is then a stability limit, not taste. The anchor takes ~¾ of the move, so
past an effective gain of ~2 the body overshoots the line by more than it was short
and rings. Plant rate plateaus there anyway: gain 2 → 94% with zero bouncing windows,
gain 6 → 95% with 53 of them. The old value of 6.0 multiplied an error term ~11u
larger, so it was far gentler than the number suggests — don't read across from it.

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

**Releasing is not always safe, though the design assumed it was.** The inductive
argument — "letting go only removes constraints" — is false for hands. Let both of
them go and what's left is a body hanging from two feet, and `POSE.FOOT_RISE`
forbids a foot above the hip outright, so *no* body position satisfies the stance.
The solver returns its best answer, the best answer is a leg folded up past the head,
and it reads as the game breaking when what happened is that the player let go of the
wall. So with no hand planted, the feet have to hold you on their own
(`stanceSolvable`, the same gate planting uses) and you fall (`CAME OFF`) if they
can't. Standing on a ledge is exactly this stance and solves cleanly, so the ordinary
case is unaffected. `T.FALL_VIOLATION` is a slower backstop for anything the rule
doesn't see.

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
violation, with nothing being dragged, the body migrates toward it. Four details
are load-bearing, all learned the hard way:

- It is applied **before** the relaxation, as an external displacement alongside
  gravity and the drag. Nudging the body afterwards is simply undone by the next
  substep's solve, which pulls straight back into the same wedge.
- It **rotates** the torso rather than interpolating its two ends. The wedged
  answer and the good one are usually mirrored, and lerping the endpoints between
  those passes through a zero-length torso, which `enforceTorso` then re-expands
  back into the wedge. Rotating is the motion that actually gets there.
- It triggers on the violation left standing at the **end** of the previous substep
  (`fig.violation`), never on a fresh mid-substep measurement. A wedge is by
  definition a fixed point of the solver, so the only honest place to observe one is
  where the solver stopped. Measuring after gravity and momentum have just been
  injected instead reads a transient the projection is about to remove — and that
  transient clears `WEDGE_TRIGGER` regularly on stances whose settled violation is
  0.00u.
- The migration is a **speed** (`WEDGE_RECOVER` units/s, `WEDGE_TURN` deg/s) scaled
  by urgency = violation / `WEDGE_REF`. `min(1, 90 * dt)` reads like a rate limit but
  closes 75% of the gap per substep — a teleport. Scaling means a 60u mirrored torso
  still reorganises immediately while a 2u nuisance creeps, which matters because a
  big correction for a small violation is one the local solver just undoes.

It fires often (26k times in a fuzz run, ~99% of them finding a better answer),
so don't assume it is a rare safety net — it is part of how the body settles. It also
gives up: `WEDGE_BUDGET` caps how long it may push at one set of holds, re-arming at
`WEDGE_REARM` — a *fraction* of the burn rate, because resetting the budget whenever
the violation momentarily cleared let a cycle refill it every time round.

### Three oscillators

The reported bug was that the figure sometimes drops into a bouncing loop. There were
three separate causes, all invisible to `sim` (which measured jitter only on the start
stance, the quietest stance on the wall) and all found by `npm run jitter`:

| Cause | Shape | Fix |
|---|---|---|
| Wedge escape triggering on a mid-substep transient, then slamming the body 18u toward an answer it didn't need | period-10, ~6% of settled stances | trigger on the settled violation; migrate at a bounded, urgency-scaled speed |
| Drag lunge armed at one line and aimed at a deeper one | period-2 at 60Hz, ~20% of held-pointer windows | one line, arming and aim; depth varies with pointer speed |
| Foot push re-injected on every relaxation pass, fighting the reach clamps | chaotic, worst on one leg folded + one at full stretch | apply once per substep as an external input, saturated by `FOOT_PUSH_RATE` |

Two of the three were *fixed* by lowering a stiffness, which is why the measurement
matters more than the fix: each had a knob that made the symptom go away and the
mechanic worse. The foot push at 0.1 stiffness stopped bouncing and left the figure
hanging off its arms (37% → 45% of bodyweight); the drag at gain 1.0 stopped ringing
and dropped plant rate to 72%.

Residual: 2.7% of held-pointer windows still ring, and no settled stance does —
1.3% overall against a baseline of 11.3% on the same metric. The gate is a rate for
held windows and zero for settled ones, since a figure bouncing while nobody is
touching it is the complaint in its purest form.

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
(currently p25 ≈ 0.30, median ≈ 0.38, p90 ≈ 0.66), so about the best third
recover. **A solver change moves this** — the oscillation fix left the figure
standing slightly lower, which pushed every stance up ~0.02 of strain and cost 8
points of rest fraction until `REST_STRAIN` followed it from 0.30 to 0.32. Harder levels are deliberately worse: `ladder` reports rests falling from
40% of stances on level 1 to 2% on level 5.
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

## Problems

**A wall is a boulder problem, not a mountain.** Thirty of them: five levels x six,
generated by `generateProblem(level, index)` from a seed derived from the level's.
Each rises ~430u (about four body lengths, most of a phone screen) and ends at a
**finish hold you match with both hands** and hold for `TOP_HOLD_TIME`.

The endless 600-move wall it replaced could not be a puzzle. You never saw the end
of one, so there was nothing to solve — only somewhere to get tired. Now the whole
sequence is on screen before you pull, which is what makes reading it possible, and
generation dropped from ~250ms to ~30ms as a side effect, so `building` barely
registers.

The top-out is generated, not hoped for: `placeFinish` samples a position that is
reachable one-handed from the final stance AND holdable with **both** hands on it,
and only commits when both stances solve. `verify` re-checks that the last stance of
every problem is both hands on the finish. Two limbs sharing a hold was always legal
in the sim — nothing checks occupancy — but no wall had ever asked for it.

`T.STYLES` gives the six problems on a level different shapes: straight up, a
traverse (a lateral target it commits to, not a louder drift — a quarter-period of a
900u sine across 250u of climbing is nearly a straight line), a foot match, long
moves, a weave, and a taller one. A style is a shape, not a second difficulty
system: every problem is generated at its level's floor and proven the same way.

**MATCH is the only style with a required move**, and `tryFootMatch` plants the
trailing foot on the hold the leading one is already on. Filler is then kept a leg's
reach away from it (`addFiller`'s guard), because a required move is only required
if there is nothing else to stand on. Route holds in that area are left alone — they
are load-bearing for the sequence — so the honest claim is that the match is the
natural move there, not that the wall forbids every alternative.

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

- `npm run verify` — re-proves every stance of all thirty problems statically,
  including the two that make up the top-out. Catches a retune of the reach
  constants silently making a problem unclimbable or untoppable.
- `npm run sim` — replays those same routes through the live per-frame solver.
  Catches oscillation, failed grabs, dynamic/static mismatch, and a top-out that
  works on paper but not in the hands.

`sim` gates the top-out separately from the plant rate: every problem must finish
with both hands on the finish hold, and the last two moves must plant without a
resync. Averaging the match into a per-move rate would hide it entirely — it is two
moves in thirty.

Expect ~89–96% per-move plant rate from `sim`; the gate is 87%. It drags for a fixed
0.18s and releases blind, and its misses split evenly between the hold sitting a hair
beyond reach at that instant and a hair inside minimum — neither of which a human
hits, because they hold until the target ring highlights. The gate is a regression
gate: the drag-gain experiments that broke responsiveness scored 63–72%.

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
arms across a problem, and it never tries to put the feet under the body, which is
why rests are scarcer than they should be. Teaching `stanceFeasible` to *prefer*
low-arm-load stances (rather than merely accept any feasible one) is the
highest-value change available.

## Menu and difficulty

The state machine is `menu → building → climbing → (falling | topped) → menu`. The
menu loads first, so **`game.wall` and `game.fig` are null until a problem is
picked** — both the update and the draw path have to tolerate that. Both endings
return to the menu carrying `game.last`, so the grid doubles as the result screen;
there is no separate retry overlay.

`building` is a real state and not ceremony, though it is far cheaper than it was:
generating a problem runs the body solver a few hundred times (~30ms on a laptop,
down from ~250ms for the endless wall). Generating inside the tap handler freezes
the menu mid-tap and reads as a dropped tap, so the tap only sets state and `update`
waits for the "building" frame to be presented before calling the generator.

The menu is canvas-drawn like the rest of the HUD, hit-tested against
`menuRects(view)`: one row per level, one tile per problem, each labelled with its
style and showing a tick once topped. Layout is derived from the view, not a design
size, so the same code works in a phone column and a letterboxed desktop window —
and drawing and hit testing read the same rects, so they cannot disagree.

**Ticks persist in `localStorage` under `climb.sent.v1`**, and every access is
wrapped in try/catch: Safari in private mode denies localStorage outright, and a
game that refuses to start because it can't remember your ticks would be a bad
trade. Failure just means the ticks don't survive a reload.

**A level is one number.** `T.LEVELS[i].floor` is a floor under the same easy→hard
scalar the height ramp already drives (`difficultyAt(height, floor)`), so it moves
hold quality, filler density and move distance together. Note that on a problem only
~430u tall the *height* half of that ramp barely engages, so a level's floor now does
nearly all the work — which is why hold quality per level (0.90 → 0.28) is flatter
within a problem and steeper between them than it was on the endless wall.

`npm run ladder` is the tool that justifies the spacing, and the table in
`tuning.js` is its output — regenerate it if you touch `LEVELS`, `MOVE_DIST`,
`QUALITY_*`, `REUSE*`, `FILL_DENSITY`, `DIFF_FULL_HEIGHT`, or anything that moves
strain. It now walks all six problems of each level, and every problem is about the
same height, so the column that used to matter (`climbed`) is flat by construction —
`rests` and `choices` are what separate the levels.

The column to watch is **`choices`**: how many legal moves a stance offers, and
`stuck`, how many of the four limbs have none at all. That is the difference
between a staircase and a problem — on level 5 an average stance offers 5 moves and
half a limb has nowhere to go, so there may be no right-hand move until the right
foot has moved. Ordering is the puzzle. Level 1 offers 10 moves a stance, where any
order works. Rests fall 42% → 5% across the ladder.

**Move distance is not the difficulty lever it looks like.** `MOVE_DIST` ramps
52 → 84 across the ladder but the *achieved* move only goes 61 → 69, because a
limb move is capped by anatomy (`ARM.max` 68, `LEG.max` 80) and the feasibility
check refuses anything longer. Asking for longer moves just costs plant rate.

**Sparseness comes from hold reuse, and nothing else.** While the generator placed
one new hold per limb move, density was pinned near 9.5 holds per 100u whatever
else you tuned — a limb can only move so far, so the holds it needs arrive at a
fixed rate. `T.REUSE` lets a move land on a hold that already exists, which breaks
that link: density now runs 12.5 → 6.2 per 100u across the ladder. (Both numbers are
higher on a problem than they were on an endless wall, because a problem is short
enough that the start stance's four jugs are a real fraction of it.)

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
per-frame update/render cost, the problem's rise/span/move count, and the centre of
mass. `R` restarts the current problem, `M` or `Escape` goes back to the menu, and
the number keys jump to a level's first problem from anywhere.
`__game.startProblem(level, index)` picks any of them from the console, but it needs
two frames to build — and `requestAnimationFrame` throttles hard when the browser
pane isn't focused, so give it seconds, not milliseconds.

Progress lives in `localStorage['climb.sent.v1']`. `__game.sent` is the live Set;
clear both to start again:

```js
localStorage.removeItem('climb.sent.v1'); __game.sent.clear();
```

Frame cost is ~0.3ms of a 16.7ms budget, so if the browser reports a low fps it's
throttling, not the game — check `msUpdate` / `msRender` before optimising.

Note that `requestAnimationFrame` gets throttled when the browser pane isn't
focused, which makes rAF-driven browser automation flaky. Prefer `npm run sim`
for anything measurable — the physics modules are pure and run headless in Node.
