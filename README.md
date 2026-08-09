# climb

A 2D bouldering game prototype for iPhone Safari. You drag a stick figure's hands
and feet onto holds, one limb at a time or several at once, and try to get up the
wall before your stamina runs out.

The point of the prototype is to find out whether dragging limbs around a wall
feels good. See [docs/BRIEF.md](docs/BRIEF.md) for scope and intent.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

### On a phone

The dev server binds to `0.0.0.0`, so either use the LAN address Vite prints, or
tunnel it:

```bash
ngrok http 5173
```

Open the ngrok https URL on the phone. Vite's allowed-hosts list already covers
ngrok domains.

## Playing

- **Drag a hand or foot** onto a hold. Holds you can reach are ringed while you
  drag; the ring thickens on the one you'll snap to when you let go.
- **Use more than one finger.** Limbs drag independently.
- Reach is finite. Pulling toward something far away makes the body lunge, but if
  it's still out of range the grab just fails and the limb hangs free.
- **Stand on your feet.** A good stance puts ~80% of your weight through your
  legs; hanging off your arms is what burns you out. Getting your hips over your
  feet is the whole game.
- Feet push, they don't pull. Over-reach with a foot and it pops off the hold.
- You fall if **all four limbs** come off the wall, or if **stamina** hits zero.
- Stamina drains from bad holds, bent limbs, being off-balance, and weight on
  your arms — and it comes back on a straight-armed, balanced, footed rest.

Tap `dbg` (or press `D`) for the strain breakdown and frame timings. `R` restarts.

## Checks

```bash
npm run verify   # every generated wall is climbable, across many seeds
npm run sim      # headless auto-climber: plant rate, stability, stamina curve
```

`verify` re-proves each route stance against the static solver. `sim` replays the
same routes through the live per-frame physics, and fails if the hanging figure
oscillates or grabs start missing. Run both after touching `src/tuning.js` or
`src/body.js`.

## Layout

Tuning constants — reach lengths, drain and recovery rates, hold quality scale,
generator parameters — all live in `src/tuning.js`. That's the file to open when
adjusting how it feels.

`src/body.js` holds the constraint solver, `src/wall.js` the seeded generator and
its climbability proof, `src/stamina.js` the three drain factors. `CLAUDE.md` has
the implementation notes, including two solver failure modes worth knowing about
before touching the physics.
