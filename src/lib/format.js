// format.js — small display-only formatting helpers shared across the
// exam and OMR modules.

// Every exam-time display and every <input type="datetime-local"> a
// teacher fills in is meant to represent Thailand wall-clock time,
// regardless of what timezone the device it's viewed/edited on happens to
// be set to (a laptop with its clock misconfigured, a browser left on
// UTC, etc.) — a plain `new Date(...)`/`toLocaleString(...)` call with no
// explicit timeZone instead silently trusts that device's own local
// timezone, which is normally Thai time but isn't guaranteed to be.
// Thailand has a single fixed UTC+7 offset with no DST, so anchoring to
// it is just a constant string, not a real timezone library.
export const BANGKOK_TZ = 'Asia/Bangkok';

// Formats an ISO timestamp in Thai locale, always against Asia/Bangkok —
// use in place of a bare `.toLocaleString('th-TH', opts)`.
export function formatThaiDateTime(isoString, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString('th-TH', { ...opts, timeZone: BANGKOK_TZ });
}

export function formatThaiDate(isoString, opts = { dateStyle: 'long' }) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('th-TH', { ...opts, timeZone: BANGKOK_TZ });
}

export function formatThaiTime(isoString, opts = { timeStyle: 'short' }) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString('th-TH', { ...opts, timeZone: BANGKOK_TZ });
}

// <input type="datetime-local"> holds a plain "YYYY-MM-DDTHH:mm" string
// with no timezone of its own — these two convert it to/from a real UTC
// instant, always treating that plain string as Thailand wall-clock time
// no matter the device's own timezone.
export function toBangkokInputValue(isoString) {
  if (!isoString) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANGKOK_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(isoString));
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function fromBangkokInputValue(value) {
  if (!value) return null;
  return new Date(`${value}:00+07:00`);
}

// ชั้น/ห้อง display: room "0" is the sentinel a subject gets when a grade
// has only a single room (no real ห้อง subdivision to distinguish), so it
// reads better omitted entirely — "ม.6" rather than "ม.6/0". A subject
// actually split into rooms (1, 2, ...) still shows the room.
export function formatGradeRoom(gradeLevel, room) {
  if (gradeLevel == null || gradeLevel === '') return '';
  const level = `ม.${gradeLevel}`;
  if (room == null || String(room).trim() === '' || String(room) === '0') return level;
  return `${level}/${room}`;
}

// Escapes a value for safe interpolation into an HTML string (SweetAlert2's
// `html:` option, a Leaflet tooltip's string content, or any other spot
// that inserts a string as markup rather than text). Needed anywhere a
// teacher-entered value (a ชุดข้อสอบ/subject title, a student name from an
// imported roster, ...) ends up inside one of those — React's own JSX
// escaping doesn't apply there, since the string is handed to a library
// that renders it as raw HTML.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}
