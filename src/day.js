/**
 * What day it is, where the player is.
 *
 * The thirty problems are regenerated from the date itself, so this module is what
 * decides which walls you get. A day is the integer YYYYMMDD -- a number rather than
 * a Date because it is a seed and a storage key as much as it is a date, and because
 * two of them compare with `===` where two Dates do not.
 *
 * **Local time, deliberately.** Every field here is read off the local calendar
 * (`getFullYear`, not `getUTCFullYear`), so the set turns over at each player's own
 * midnight rather than at one shared instant that lands mid-evening for some of them
 * and mid-morning for others. The cost is that two players in different zones are
 * briefly on different walls, which is the right trade for a game whose whole daily
 * ritual is "there is a new set when you wake up".
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Today as YYYYMMDD, in local time. Pass a Date to ask about another moment. */
export function today(now = new Date()) {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/** A day number back to a local Date, at midnight. */
export function dayDate(day) {
  return new Date(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100);
}

/**
 * `n` days after `day`, negative for before. Goes through Date rather than doing
 * arithmetic on the digits so month and year ends look after themselves.
 */
export function shiftDay(day, n) {
  const d = dayDate(day);
  d.setDate(d.getDate() + n);
  return today(d);
}

/** 'FRI 14 AUG', for the menu header. */
export function dayLabel(day) {
  const d = dayDate(day);
  return `${WEEKDAYS[d.getDay()]} ${String(day % 100).padStart(2, '0')} ${MONTHS[(Math.floor(day / 100) % 100) - 1]}`;
}

/** Does this look like a day number at all? Guards what comes back from storage. */
export const isDay = (day) => Number.isInteger(day) && day >= 19700101 && day <= 99991231;

/**
 * `--day=YYYYMMDD` (or `--day=today`) off a command line, else `fallback`. Lives here
 * with the rest of the day handling because all five headless tools take it, and the
 * one thing they must agree on is what a day is.
 */
export function dayArg(argv, fallback) {
  const arg = argv.find((a) => a.startsWith('--day='));
  if (!arg) return fallback;
  const v = arg.slice(6);
  if (v === 'today') return today();
  const day = Number(v);
  if (!isDay(day)) throw new Error(`--day wants YYYYMMDD or "today", got "${v}"`);
  return day;
}
