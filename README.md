# climb

A 2D bouldering game prototype for iPhone Safari. You drag a stick figure's hands
and feet onto holds, one limb at a time or several at once, and try to top the
problem before your stamina runs out.

Thirty problems: five difficulties, six problems each, every one a short sequence
you can read from the ground. They come in styles -- a traverse, one that wants
both feet on the same hold, a reachy one -- and they are ticked off when topped.

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
- **Tap a limb to take it off its hold.** Planted limbs limit how far your body
  can move, so if a hold is out of reach, letting go of a trailing foot buys you
  the stretch — at the cost of holding the position on what's left. Nothing ever
  comes off the wall on its own.
- **Top out by matching the finish hold with both hands** and holding it for a
  moment. The top is ringed and labelled; controlling it is the last move, the way
  it is in a real gym.
- You fall if **all four limbs** come off the wall, if **stamina** hits zero, or if
  you let go of both hands somewhere your feet can't hold you on their own.
- Stamina drains from bad holds, bent limbs, being off-balance, and weight on
  your arms — and it comes back on a straight-armed, balanced, footed rest.

Tap `dbg` (or press `D`) for the strain breakdown and frame timings. `R` restarts.

## Checks

```bash
npm run verify   # every problem is climbable and can be topped out
npm run sim      # headless auto-climber: plant rate, top-outs, stability, stamina
npm run jitter   # does the body ever settle into a bouncing loop?
npm run fuzz     # haul three limbs at once to absurd places; can the body break?
npm run ladder   # are the five difficulties actually five difficulties?
npm run measure  # what the biophysics model does, in numbers
```

`verify` re-proves every stance of all thirty problems against the static solver,
including the two that make up the top-out. `sim` replays the same routes through
the live per-frame physics and fails if grabs start missing or a problem stops
being toppable. Run both after touching `src/tuning.js` or `src/body.js`.

## Layout

Tuning constants — reach lengths, drain and recovery rates, hold quality scale,
generator parameters — all live in `src/tuning.js`. That's the file to open when
adjusting how it feels.

`src/body.js` holds the constraint solver, `src/wall.js` the seeded generator and
its climbability proof, `src/stamina.js` the three drain factors. `CLAUDE.md` has
the implementation notes, including two solver failure modes worth knowing about
before touching the physics.
