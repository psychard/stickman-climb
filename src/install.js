/**
 * Does this device want a nudge to install the game to its home screen?
 *
 * Worth asking on the target device and nowhere else. A home-screen launch on
 * iOS drops Safari's toolbars, and on a phone those are a real fraction of the
 * screen -- the wall gets taller, and the bottom bar stops sitting where a thumb
 * drags a foot. So the menu says so, once installed it stops, and everywhere
 * else (desktop, Android) it never appears: Android's own install prompt is the
 * browser's job and macOS has no home screen to add to.
 *
 * Deliberately a sniff and not a `beforeinstallprompt` handler. iOS Safari
 * doesn't fire that event and never will; the instruction *is* the mechanism.
 */

let cached = null;
let menuStep = null;
let forced = null; // dev override, exposed as window.__installHint (see main.js)

/** True on an iOS device that is browsing the site rather than running it installed. */
export function wantsInstallHint() {
  if (forced !== null) return forced !== false;
  if (cached === null) cached = detect();
  return cached;
}

/**
 * Is Share behind the ⋯ menu rather than on the toolbar?
 *
 * Safari 26 moved it: the toolbar carries a ⋯ button and the share sheet is one
 * level in, so the old instruction sends people looking for a glyph that isn't
 * there any more. Sniffed from the `Version/` token rather than shown to
 * everyone, because it is equally wrong in the other direction on Safari 18 --
 * and on anything without that token (Chrome and Firefox on iOS both omit it,
 * and both keep a share control of their own in reach) the older, shorter
 * instruction is the safer guess.
 */
export function wantsMenuStep() {
  if (typeof forced === 'string') return forced === 'menu';
  if (menuStep === null) menuStep = detectMenuStep();
  return menuStep;
}

/**
 * Force the hint on or off for a frame-accurate look at it on a desktop, where
 * it would otherwise never draw. `null` hands the decision back to `detect`;
 * 'menu' and 'share' additionally pin which route the second line describes.
 */
export function forceInstallHint(value) {
  forced = value;
}

function detectMenuStep() {
  if (typeof navigator === 'undefined') return false;
  const version = /version\/(\d+)/i.exec(navigator.userAgent || '');
  return version ? Number(version[1]) >= 26 : false;
}

function detect() {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Macintosh, so it needs the touch-point tell as
  // well. A real Mac reports 0 points and is excluded, which is the intent.
  const ios =
    /iphone|ipod|ipad/i.test(ua) ||
    (/macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  return ios && !installed();
}

/**
 * Already added to the home screen and launched from it.
 *
 * Exported as well as used here, because the safe-area insets behave differently in
 * an installed app and that is the one place they cannot be checked while developing
 * -- the debug overlay reports which of the two you are in, alongside the insets it
 * actually got. See the status-bar-style comment in index.html.
 */
export function installed() {
  // navigator.standalone is iOS's own flag and predates display-mode by years;
  // the media query is the standard one, and only newer Safari answers it.
  if (navigator.standalone === true) return true;
  try {
    return window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}
