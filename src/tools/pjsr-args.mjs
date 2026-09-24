// ============================================================================
// Argument helpers for building PJSR safely, shared by the tool modules folded in
// from mxcoppell/pixinsight-pack-astro@eee19b3 (lib/pjsr.mjs). A helper module:
// it exports no `tools` array, so src/tools/index.mjs's scan passes over it.
//
// Every string that reaches PJSR goes through q() (a JSON string literal); every
// bare number goes through num() (runtime-checked finite); every view ID spliced
// into a PixelMath expression goes through vid() (must be a PixInsight
// identifier), because a PixelMath expression is itself code and a quoted PJSR
// string does not protect it.
//
// num/int/bool/oneOf take (value, fallback, label). The fallback is used only when
// the value is undefined or null; pass `undefined` for a value with no default, and
// the helper throws "<label>: expected ..." when it is absent.
// ============================================================================

export const q = (s) => JSON.stringify(String(s));

// num(value, fallback, label) -> number. A number interpolated bare into PJSR
// cannot be quoted like a string, so its runtime type is checked instead of
// trusted from the JSON Schema alone.
export function num(value, fallback, label = 'value') {
  const v = value === undefined || value === null ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${label}: expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

// int(value, fallback, label) -> integer (for loop counts, radii, layers).
export function int(value, fallback, label = 'value') {
  const v = num(value, fallback, label);
  if (!Number.isInteger(v)) throw new Error(`${label}: expected an integer, got ${JSON.stringify(v)}`);
  return v;
}

// bool(value, fallback, label) -> boolean. MCP clients sometimes send "true"/"false" as strings;
// a bare truthiness test would read the string "false" as true.
export function bool(value, fallback, label = 'value') {
  const v = value === undefined || value === null ? fallback : value;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new Error(`${label}: expected a boolean, got ${JSON.stringify(v)}`);
}

// PixInsight view identifiers: letters, digits, underscore, not starting with a digit.
const VIEW_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// vid(id, label) -> id. Required wherever a view ID is written into a PixelMath
// expression (e.g. `${vid(haId)} - 0.28 * ${vid(rgbId)}[0]`), or into a PJSR
// identifier position, rather than looked up by a quoted string.
export function vid(id, label = 'view_id') {
  if (typeof id !== 'string' || !VIEW_ID_RE.test(id)) {
    throw new Error(`${label} must be a PixInsight view identifier (letters, digits, underscore, not starting with a digit); got ${JSON.stringify(id)}`);
  }
  return id;
}

// oneOf(value, allowed, fallback, label) -> value, checked against an allow-list.
export function oneOf(value, allowed, fallback, label = 'value') {
  const v = value === undefined || value === null ? fallback : value;
  if (!allowed.includes(v)) throw new Error(`${label}: expected one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
  return v;
}

// pjsrJson(api, code) -> parsed JSON from the snippet's final expression, or throws with the
// PJSR error message.
export async function pjsrJson(api, code, what = 'PJSR') {
  const r = await api.pjsr(code);
  if (r.status === 'error') throw new Error(`${what} failed: ${r.error?.message || JSON.stringify(r.error)}`);
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

// newImages(api, beforeIds) -> the images open now that were not open before (the
// connector-internal detectNewImages, expressed through api.listImages).
export async function newImages(api, beforeIds) {
  const before = new Set(beforeIds);
  return (await api.listImages()).filter((i) => !before.has(i.id));
}

// closeViews(api, ids) -> force-close every listed view that is open.
export async function closeViews(api, ids) {
  if (!ids.length) return;
  await api.pjsr(`var ids = ${JSON.stringify(ids.map(String))};
    for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.forceClose(); }`);
}

// fixed(v, digits) -> v.toFixed(digits), or '?' for anything that is not a finite number.
const f = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '?');

export { f as fixed };

// A PixelMath numeric literal with at least 10 significant digits, never in exponent form.
export function lit(v) {
  let s = v.toPrecision(16);
  if (/e/i.test(s)) s = v.toFixed(20);
  return v < 0 ? `(${s})` : s;
}
