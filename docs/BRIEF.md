# Bouldering Game — Prototype Brief

> This is the original brief, kept verbatim as the source of truth for scope and
> intent. If the code and this document disagree about *what we're building*,
> this document wins.

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
| **Limb extension** | The closer a limb is to its max reach, the more it strains. Fully extended limbs drain faster. |
| **Center of mass** | The further the figure's center of mass sits outside its base of support (the polygon formed by the planted limbs), the faster the drain. |

**Design intent behind these:** the underlying question we're approximating is *"would an average human struggle to hold this position?"* We are deliberately **not** attempting real biomechanics. Start with the three cheap signals above, tune them until the game feels honest, and only add nuance (pull angles, opposing forces, foot vs. hand load) if the simple version feels wrong.

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
- Should feet and hands have different reach and different stamina costs? (Real climbing: legs are far stronger.)
- Does the figure need momentum for dynamic moves, or is everything static/positional?
