# Bouldering Game — Prototype Brief

> The source of truth for scope and intent. If the code and this document
> disagree about *what we're building*, this document wins.
>
> The body is the original brief. Where playing the prototype proved part of it
> wrong, the text has been corrected in place and the change recorded under
> [Revisions](#revisions) — so this file always describes what we actually want,
> and the reasoning for each departure is still on the record.

## Concept

A 2D web-based climbing game, optimized for iPhone Safari. The player controls a stick figure on a bouldering wall by dragging its hands and feet onto holds. Multitouch means more than one limb can be moved at once. The goal is to top out a short problem — reach its finish hold and match it with both hands — without falling.

The feel we're going for is **tactile and physical** — the figure should behave like a weighted puppet, not a set of free-floating cursors. Getting that feel right is the entire point of this prototype.

---

## Core Mechanics

### The figure

- Stick figure: torso, two arms, two legs. Four grab points (two hands, two feet).
- Player drags a limb's endpoint toward a hold to place it there.
- **Multitouch:** two or more limbs can be dragged simultaneously.

### Reach and body movement

- Each limb has a **finite maximum reach**. Limbs do not stretch beyond it.
- When a player pulls a hand toward a distant hold, the **torso and hips shift** to help — the figure lunges. Planted limbs stay on their holds; the body rotates and leans around them.
- If a hold is still out of range after the body has shifted as far as it can, the grab simply fails. No Spider-Man stretching.
- There is *some* elasticity in reach, but it's tightly bounded.

### Topping out

A problem ends at a **finish hold you match with both hands** and hold for a moment.
Slapping it is not enough — controlling the top is the last move, the way it is in a
gym. Topping a problem ticks it off the grid, and the ticks persist.

### Falling

The player falls if:

1. **All four limbs leave the wall** at once,
2. **Stamina runs out**, or
3. **Both hands come off** somewhere the feet cannot hold the body on their own.
   Hanging from two feet is anatomically impossible, so there is no body position to
   draw — you have let go of the wall with nothing underneath you.
4. **Both hands are off and your weight goes past your feet**, and stays there. With
   no hand on the wall you are standing rather than hanging, so the centre of mass
   has to be over the base of support. You can be out past it briefly — that is a
   lunge — but not indefinitely.

### Stamina

A bar that drains continuously based on how strenuous the current position is, and **recovers when the figure is in a stable, restful stance**. This is the pacing mechanic — it pushes the player to keep moving and to hunt for rest positions, the way real climbing does.

Three drain factors for v1:

| Factor | Description |
|---|---|
| **Hold quality** | Every hold has a "goodness" rating. A deep jug you could hang off all day drains almost nothing; a tiny crimp bleeds stamina fast. |
| **Limb flexion** | The more a limb is *bent*, the more it strains. A straight arm hangs off bone and is nearly free; the locked-off arm burns. Legs are the same — a straight leg is cheap, a deep high step is brutal. |
| **Balance** | The further the figure's center of mass sits sideways of the contacts actually carrying it, the faster the drain. A narrow base of loaded contacts makes the same offset worse. |
| **Arm load** | The share of bodyweight going through the arms, whatever the holds are like. Hanging off your arms is what you're trying to avoid. |

**Design intent behind these:** the underlying question we're approximating is *"would an average human struggle to hold this position?"* We are deliberately **not** attempting real biomechanics. Start with the cheap signals above, tune them until the game feels honest, and only add nuance (pull angles, opposing forces) if the simple version feels wrong.

Stamina recovery should be meaningfully achievable — a good hold with a balanced, compact body position should regain stamina at a noticeable rate.

### Camera

The view scrolls to keep the figure roughly centered as they climb. The wall scrolls down past them.

---

## Wall Generation

- **Procedurally generated from a seed.** The same seed always produces the same problem, so a problem you ticked off is the one you solved. (Later: let players enter a seed to replay or share a specific climb — not needed for the prototype, but don't design it out.)
- **A problem is short** — about four body lengths, readable from the ground before you pull — and ends at a finish hold. An endless wall is a marathon, not a puzzle.
- **Hard constraint: every generated problem must be climbable, and toppable.** The generator verifies that each successive move is within the figure's reach envelope from a plausible stance, and that the finish can be reached one-handed and then held with both. Don't generate holds and hope. `npm run verify` re-proves all thirty.
- Difficulty ramps with height, and a level sets a floor under that ramp: holds get sparser, smaller, and further apart. On a problem this short the floor does nearly all of the work.
- **Five difficulty levels x six problems**, chosen from a grid. Problems within a level differ in *style* rather than difficulty — a traverse, one that wants both feet on a hold, a reachy one — so a level teaches variety and the ladder still means one thing.
- **Sparse walls are the goal at the hard end, not just bad holds.** It is correct for there to be no legal right-hand move until the right foot has moved, and none for that until the left foot has. Working out which limb can move, and in what order, is the puzzle — so the generator reuses holds rather than placing a fresh one for every move.

---

## Prototype Scope

Build **only** this:

- Thirty short problems: five difficulties x six, picked from a grid. Each ends at a
  finish hold matched with both hands, and is ticked off once topped.
- 2D stick figure with four draggable limbs.
- Multitouch dragging.
- Max-reach limits with body lunge/shift.
- Stamina bar with the three drain factors and recovery.
- Falling on peel-off, on stamina depletion, and on letting go of both hands where
  the feet cannot hold you; falling returns to the menu.
- Scrolling camera.

Explicitly **out of scope for now** (do not build these yet):

- Visual polish, art, animation flourishes
- Seed entry or sharing
- Scoring, leaderboards, progression, saved results
- Sound

The one thing this prototype has to prove is that **dragging limbs around a wall feels good**. Everything else waits.

---

## Technical Notes

- **Target:** iPhone Safari, portrait. Should also run on desktop for development convenience (mouse = single-touch).
- HTML5 Canvas is likely the right call for rendering; keep it to a single file if practical.
- Use **Pointer Events** for input so mouse and touch share a code path, and track pointer IDs so simultaneous drags stay independent.
- Set `touch-action: none` and prevent default on the canvas to stop Safari's scroll, zoom, and pull-to-refresh from hijacking drags.
- Handle the viewport properly: `viewport-fit=cover`, respect safe-area insets, and account for Safari's dynamic toolbar (`100dvh` or a resize-driven canvas sizing).
- Target 60fps. The physics here is light — a small constraint solver over 4 limbs and a torso, not a full rigid-body engine. Avoid pulling in a heavy physics library unless a hand-rolled solution proves inadequate.
- Keep the tuning constants (reach lengths, drain rates per factor, recovery rate, hold quality scale) collected in one obvious place. They will be adjusted constantly.

---

## Open Questions for Later

- How exactly should the torso shift resolve when two limbs are dragged in opposite directions simultaneously?
- Does the figure need momentum for dynamic moves, or is everything static/positional?

---

## Revisions

### 2026-08-09 — biophysics pass

The original v1 stamina model was built as written above and then played. These
changes came out of that, and this section is the reason the table above no
longer matches the first draft.

**Limb extension became limb flexion — the original rule had the wrong sign.**
The brief said strain rises as a limb approaches max reach. It's the reverse: a
straight arm loads bone and connective tissue and is the classic rest position,
while the bent, locked-off arm is what pumps you out. Legs behave the same way.
As written, the model penalised good technique and rewarded pulling in.

**Load distribution became geometric.** Load was a fixed constant per limb type,
so a hand always carried ~64% of bodyweight whether you were standing on your
feet or hanging off your arms. Moving your hips over your feet — the single most
important technique in climbing — therefore did nothing at all. Each contact's
share now comes from how well it opposes gravity and how near the centre of mass
sits to it. Standing well now puts ~80% through the feet.

**"Base of support" became balance, and gained an arm-load term.** A support
polygon is a floor concept; on a vertical wall gravity only destabilises you
sideways. Real barn-dooring rotates out of the wall plane, which this game
cannot represent — we decided against a depth axis — so what's modelled is its
in-plane shadow. The separate arm-load term exists because without it a dead
hang from two jugs scored as a perfect rest.

**Feet can no longer pull, and nothing peels by itself.** A planted foot used to
tether the body in tension, so you could hang from your feet. The first fix made
an over-extended leg peel the foot off — which turned out to read as the game
breaking rather than as a mistake you'd made, because an ordinary reach would
silently strip both feet and leave you hanging from one hand.

A planted limb now *limits* how far the body can travel, so over-reaching is
prevented rather than punished. For a foot that limit is kinematic — your leg is
only so long — not the foot bearing tension, and the load model still gives it
no share unless it's genuinely underneath you. **Tapping a limb releases it**,
which is how you buy the extra reach: give up a contact, and hold the position on
what's left.

**Limbs gained anatomical pose cones.** Limbs were pure distance constraints, so
a foot was legal anywhere on a ring around the hip, including above the chest.

### 2026-08-09 — menu and five difficulties

Requested after playing the single wall: it is too easy, because it has so many
holds. Menus and level select had been explicitly out of scope; they're in now,
and the scope list above has been corrected rather than left contradicting the
game.

**A level is a floor, not a second difficulty system.** The brief already said
difficulty ramps with height. A level now sets where on that ramp you start, so
one number moves hold quality, filler density and move distance together. Level 1
is floor 0 — the original wall, route-identical.

**Harder walls have genuinely fewer holds, via reuse.** The first attempt at this
concluded that hold density was fixed by anatomy — one new hold per limb move, and
a limb can only move so far. That was wrong, and it was wrong because it assumed
every move needs its *own* hold. A hold placed for a hand sits at foot height a
body-length later, so a foot can just step onto it and the move costs no hold at
all. The generator now tries reuse before inventing anything, more often as
difficulty rises, and density falls 8.8 → 4.1 holds per 100u across the ladder.

Reuse is feet-only in practice: the hands are the top of the route, so there is
never anything above them to move onto. That puts a floor of about one new hold per
hand move on this design.

**Order is the puzzle, and it's now measured.** `npm run ladder` reports how many
legal moves a stance offers and how many limbs have none. Level 1 offers 10.7 moves
per stance, so any order works. Level 5 offers 4, with more than one limb stuck on
average — so there may be no right-hand move until the right foot has moved, and
none for that until the left foot has. Hold quality still carries the stamina side
of the ladder (0.79 → 0.15, rests 40% → 5%).

**The fall screen was folded into the menu.** Falling now returns to the list
carrying the reason and height, rather than showing a retry overlay, so a retry is
one tap and switching walls is the same tap.

### 2026-08-09 — the body could be dragged into impossible shapes

Reported from play: the figure could be stretched into weird unphysical
configurations. Reproduced by fuzzing multi-limb drags, which found a 208u leg, an
inverted torso and pose violations of 180u. Four causes, all measured:

**The drag lunge was unbounded** — it multiplies the shortfall between pointer and
reach, so hauling a limb to three times its length asked for ~880 units of body
travel in a single 1/120s substep. **Pose was measured against the raw pointer**,
so a pointer flung across the wall shoved the body by that distance at full
strength. **The torso could invert**, which mirrors every anatomical limit because
the cones live in the torso frame, so they then held the figure in impossible
shapes rather than out of them. And **reach did not actually get the last word**
despite the design saying it should, because every projection pass ended with pose
and torso corrections applied after the clamps.

**A stance can be entered that no body can hold.** Checking that one limb can
reach one hold is not enough: plant four limbs one at a time, each legal when
taken, and the body moves between grabs until the combination is impossible. The
solver was returning the best available answer and the best available answer was a
99u leg. Grabs are now refused if the resulting stance has no solution, the same
check the generator already applies to every hold it places. This is the brief's
existing "the grab simply fails" rule, applied to the stance rather than the limb.

The solver can still settle in a bad local minimum, so `escapeWedge` detects that
and migrates the body toward the globally-solved answer. Together these took the
adversarial fuzzer from 254 bad runs in 300 to 1, and the auto-climber from failing
every level to passing all five over the full route.

### 2026-08-12 — the figure sometimes bounced in a loop

Reported from play: "sometimes it gets jittery again — keeps bouncing in a loop or
oscillating." It was three unrelated limit cycles, none of which the existing tools
could see, because `sim` measured jitter only on the start stance — the quietest
stance on the wall — and every other invariant was perfectly happy with a body that
was bouncing. A new tool (`npm run jitter`) watches a second of no input after every
move and again with the pointer held still, and scores **wander**: path length that
went nowhere. It found a cycle in 11.5% of windows.

The three causes were the **wedge escape** firing on a mid-substep transient that the
solver was about to fix anyway and throwing the body 18u in response, the **drag
lunge** being armed at one distance and aimed at a deeper one (a bang-bang controller
that overshot its own dead zone at 60Hz), and the **foot push** being re-applied on
every relaxation pass so it fought the reach clamps that were meant to arrest it.
Down to 1.5% of windows, with settled stances at 0.2%.

Two of the three had a knob that made the symptom disappear and the game worse —
weakening the foot push stopped the bouncing and left the figure hanging off its arms
instead of standing on its feet; weakening the drag stopped the ringing and dropped
one grab in four. That is the argument for measuring the mechanism rather than tuning
until it looks calm.

**A new fall reason, `CAME OFF`.** The brief said you fall when all four limbs leave
the wall or stamina runs out. There was a third case hiding in the design's claim that
releasing a limb is always safe: let go of *both hands* and what remains is a body
hanging from two feet, which the anatomical limits forbid outright, so no body
position satisfies it and the solver draws a wreck. Physically you have just let go of
the wall with nothing underneath you. So with no hand planted, the feet must be able
to hold you alone — the same solvability test planting already uses — and you fall if
they can't. Standing on a ledge is exactly that stance and is unaffected.

### 2026-08-12 — holds are drawn as five kinds

Requested after playing: the holds should look more clearly different. "Visual polish,
art" was on the out-of-scope list; this part of it is in now, and for a reason that
serves the prototype's question rather than decorating it — every hold was the same
blue circle at a slightly different diameter, so reading a wall meant comparing
diameters, and route-finding is most of what the player is actually doing.

Holds are now drawn as a jug, pocket, pinch, sloper or crimp, each with its own colour
and silhouette. **The sim is unchanged**: a hold is still one direction-free quality
scalar, and nothing outside the renderer reads the kind. Shape is chosen from
overlapping quality bands, so it correlates with quality — a hold that looks like a jug
has to be a good one, because quality is what drives strain — while still giving a
given quality two or three possible silhouettes so the wall doesn't read as banded.

The kind is hashed from the hold's own position rather than drawn from the generator's
random stream, so no wall geometry moved: `verify` produces byte-identical routes.

### 2026-08-12 — thirty short problems, each with a top

Requested from play: multiple walls per difficulty, much shorter, "more like
bouldering, where it's more of a puzzle than a marathon", with an end you touch with
both hands and problems that ask for different things.

**A wall is now a boulder problem.** Five levels x six problems, ~430u each — about
four body lengths, most of a phone screen — ending at a finish hold you match with
**both hands** and control for a moment. The endless 600-move wall could not be a
puzzle: you never saw the end of one, so there was nothing to solve, only somewhere
to get tired. The scope list above said five walls, one seed each; it is thirty now.

**The top-out is generated and proven, not hoped for.** The generator places the
finish only where one hand can reach it from the final stance *and* both hands can
hold it, and both stances go through the same solver check as every other hold. Two
limbs on one hold was always legal in the sim — nothing ever checked occupancy — but
no wall had asked for it, so the move existed and was never used.

**Problems come in styles**, which is what "require different things" turned into: a
traverse that commits to a lateral target, one that wants both feet on the same hold
(with the alternatives kept a leg's reach away, so the match is the natural move), a
reachy one, a weave, a taller one. A style is a shape, not a second difficulty
system — every problem is generated at its level's floor and proven the same way.

**Topping a problem ticks it off**, and the ticks persist across sessions. Scoring
and progression were explicitly out of scope; a tick is neither, it is the record of
which of the thirty you have solved, and without it "multiple problems per level" has
no shape.

Stamina was re-calibrated to suit: on a thirty-move problem it is a pace to keep
rather than a fuel gauge to eke out, so rests run 42% of stances on level 1 down to
5% on level 5.

### 2026-08-14 — a new set every day

Requested: the climbs should be different each day, seeded from the date, turning
over at each player's own local midnight, with the ticks resetting and a record kept
of what was topped on which day.

**The thirty problems are now the day's.** `problemSeed` folds a `YYYYMMDD` integer
in with the level and index, so everyone on the same calendar day climbs the same
thirty walls and tomorrow they are gone. The date is read off the *local* calendar,
so the set turns over at each player's own midnight rather than at one shared instant
that would land mid-evening for half of them. The menu shows the date, because
otherwise the ticks appear to clear themselves overnight for no visible reason — and
it is drawn as a chip sized for a thumb, since it is about to become the way into a
calendar of past days. The menu is titled STICKMAN CLIMB, matching the name it
installs under, rather than the CLIMB it said when there was only one thing it could
have meant.

**A tick now means "I did this one today".** Ticks are stored per day
(`climb.days.v1`) rather than as one flat list, so the record of which problems were
topped on which day survives the reset — which is what a streak, a score or a
calendar will be built from. The old flat list is dropped rather than migrated: the
walls it named cannot be generated any more.

**This exposed a real defect and it was fixed rather than papered over.** The
generator's walk can dead-end — no limb has a legal move left, and no finish hold can
be placed from the stance it is stuck in — leaving a problem with no top-out, which
is unwinnable because matching the top is the only way to send. Sweeping 5400
problems found 3 of them, all on levels 1–2. That was harmless while the thirty walls
were fixed and checked once; generating a fresh thirty daily on a device nobody can
run `verify` on would have handed somebody an unwinnable problem every couple of
months. A dead-ended walk is now simply walked again from a derived seed.

**Nothing about difficulty moved.** The re-roll runs the same generator at the same
level floor, hold quality, move distance and feasibility gate — it is another draw
from an identical distribution, not an easier one, and a problem that defeats you is
still expected to. What is guaranteed is only that a legal top-out exists.

### 2026-08-15 — base of support came back, for the one case it was right about

Reported from play: take both hands off with two fingers and drag them out sideways,
and the figure leans horizontally past its feet — both of which can be on the same
pinch — and just stays there, defying gravity for as long as your fingers don't move.

It really did stay there. Reproduced headless, the pose is a genuine equilibrium:
75u outside the foot span at 0.00u of constraint violation. Nothing in the solver
computes a moment — the constraints are distances, cones and torso length — so
nothing objected. The one consequence was a stamina drain taking 10.2 seconds to
bite, which reads as getting tired rather than as doing something impossible.

**This does not reverse the biophysics pass above, which replaced base of support
with a sideways-offset drain.** That reasoning was right about the case it was
about: with a hand on the wall you are hanging, gravity only destabilises you
sideways, and 43% of real route stances legitimately put the COM outside the foot
span (p90 17u, max 44u). It just never covered the case where there is no hand on
the wall at all — and then you are standing, the footholds are your floor, and the
floor concept is exactly the right one. So the polygon is back, scoped to that case
and only that case.

The scoping is what makes it safe rather than merely cheap: **0 of the 1112 route
stances across all thirty problems have no hand planted**, so `verify`, `sim`,
`jitter` and `measure` all come back bit-identical, and the strain calibration and
plant rate could not move if they wanted to.

**What actually holds the body back is not what it looked like.** The obvious fix —
a restoring push toward balance — is a 2.7u-per-substep force against a drag allowed
110, and it loses 40:1; with it in, the body sat exactly where it had before and all
that changed was that a timer was running. Instrumenting the substep showed the thing
hauling the body out there is the **pose correction on the cross-body hand**: drag
your right hand past your left side and the torso is pushed sideways to make that
reach anatomically possible, at full stiffness, on every relaxation and projection
pass. Out past the feet that settles into a horizontal equilibrium against the
stretched leg, which no soft force reaches. So balance joins reach as something the
body is *projected* into after the constraints have run, and wins the tie for the
same reason over-stretch does.

**A lunge is still a lunge.** Measured with the feet 45u apart and the pointers
hauled off the side of the wall: full stretch drops you at 0.46s, a moderate lean at
0.68s, and throwing out and coming back survives up to ~350ms out there. Standing
balanced on the feet alone is free indefinitely. The base of support is drawn under
the feet the moment the second hand comes off, because otherwise the rule is
invisible until it kills you.

### Still open

- Holds are still a direction-free quality scalar. No underclings, sidepulls or
  slopers that only work when pulled a particular way. Deferred deliberately.
- Fatigue is still one global bar, though strain is now computed per limb, so
  per-limb pump (and shaking out one arm) is a small step from here.
- The generator only checks that stances are *possible*, not that they're good.
  It produces walls where ~30% of bodyweight sits on the arms on an average
  stance and never tries to put the feet under the body, which is why rest
  positions are scarcer than they should be. This is the highest-value piece of
  work left.
- No depth axis, decided deliberately. The sim is 2D in the plane of the wall, so
  keeping your hips in close to the wall — arguably the real biomechanical driver
  of difficulty — cannot be represented at all, and neither can true
  barn-dooring. Revisit only if the game feels wrong in a way nothing else
  explains.
