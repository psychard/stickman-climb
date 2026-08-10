/**
 * Pointer plumbing. Mouse and touch share one code path via Pointer Events;
 * every pointer is tracked by id so two (or four) simultaneous drags stay
 * independent.
 *
 * Safari specifics handled here: touch-action is none in CSS, but we also
 * preventDefault on the pointer/touch stream and swallow gesture events so a
 * two-finger drag can't become a pinch-zoom mid-move.
 */

export function attachInput(canvas, game) {
  const toLocal = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    game.pointerDown(e.pointerId, toLocal(e));
  };

  const onMove = (e) => {
    e.preventDefault();
    // Coalesced events give the true sub-frame path on 120Hz iPhone displays;
    // we only need the latest position, but reading it this way avoids lag.
    const evts = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const last = evts && evts.length ? evts[evts.length - 1] : e;
    game.pointerMove(e.pointerId, toLocal(last));
  };

  const onUp = (e) => {
    e.preventDefault();
    game.pointerUp(e.pointerId, toLocal(e));
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  canvas.addEventListener('pointerdown', onDown, { passive: false });
  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp, { passive: false });
  canvas.addEventListener('pointercancel', onUp, { passive: false });

  // belt and braces against Safari scroll / zoom hijacking a drag
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // keyboard shortcuts for desktop development
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') game.restart();
    if (e.key === 'd' || e.key === 'D') game.toggleDebug();
    if (e.key === 'm' || e.key === 'M' || e.key === 'Escape') game.showMenu();
    // number keys jump straight to a level, from the menu or mid-climb
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1) game.startLevel(n - 1); // startLevel clamps
  });
}
