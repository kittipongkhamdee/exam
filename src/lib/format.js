// format.js — small display-only formatting helpers shared across the
// exam and OMR modules.

// ชั้น/ห้อง display: room "0" is the sentinel a subject gets when a grade
// has only a single room (no real ห้อง subdivision to distinguish), so it
// reads better omitted entirely — "ม. 6" rather than "ม. 6/0". A subject
// actually split into rooms (1, 2, ...) still shows the room.
export function formatGradeRoom(gradeLevel, room) {
  if (gradeLevel == null || gradeLevel === '') return '';
  const level = `ม. ${gradeLevel}`;
  if (room == null || String(room).trim() === '' || String(room) === '0') return level;
  return `${level}/${room}`;
}
