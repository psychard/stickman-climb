# Bouldering Game — Prototype Brief

> The source of truth for scope and intent. If the code and this document
> disagree about *what we're building*, this document wins.
>
> The body is the original brief. Where playing the prototype proved part of it
> wrong, the text has been corrected in place and the change recorded under
> [Revisions](#revisions) — so this file always describes what we actually want,
> and the reasoning for each departure is still on the record.

## Concept

A 2D web-based climbing game, optimized for iPhone Safari. The player controls a stick figure on a bouldering wall by dragging its hands and feet onto holds. Multitouch means more than one limb can be moved at once. The goal is to reach the top of the wall without falling.

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

### Falling

The player falls if either:

1. **All four limbs leave the wall** at once, or
2. **Stamina runs out.**

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

- **Procedurally generated from a seed.** The same seed always produces the same wall.
- Effectively infinite wall space. (Later: let players enter a seed to replay or share a specific climb — not needed for the prototype, but don't design it out.)
- **Hard constraint: every generated wall must be climbable.** The generator needs to verify that each successive move is within the figure's reach envelope from a plausible stance. Don't generate holds and hope.
- Difficulty ramps with height: holds get sparser, smaller, and further apart as the player ascends.

---

## Prototype Scope

Build **only** this:

- One wall, one fixed seed.
- 2D stick figure with four draggable limbs.
- Multitouch dragging.
- Max-reach limits with body lunge/shift.
- Stamina bar with the three drain factors and recovery.
- Falling on peel-off and on stamina depletion.
- Scrolling camera.

Explicitly **out of scope for now** (do not build these yet):

- Visual polish, art, animation flourishes
- Difficulty tuning beyond rough placeholders
- Seed entry, sharing, or level select
- Menus, scoring, leaderboards, progression
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

### Still open

- Holds are still a direction-free quality scalar. No underclings, sidepulls or
  slopers that only work when pulled a particular way. Deferred deliberately.
- Fatigue is still one global bar, though strain is now computed per limb, so
  per-limb pump (and shaking out one arm) is a small step from here.
- The generator only checks that stances are *possible*, not that they're good.
  It produces walls where ~47% of bodyweight sits on the arms on an average
  stance, which is why rest positions are scarcer than they should be.
