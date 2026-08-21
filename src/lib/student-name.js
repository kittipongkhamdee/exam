// student-name.js
//
// public.students.student_name already has the prefix (เด็กชาย/เด็กหญิง/...)
// baked in for every row across every grade/room in this shared Supabase
// project — confirmed live: 100% of ~110 students, e.g. student_name
// "เด็กชายขวัญชัย  แก้วนรา" with prefix "เด็กชาย" stored separately too
// (this app doesn't own the roster; it's maintained on the ปพ.5 side).
// Every place in this app that displayed `${prefix}${student_name}` was
// therefore always doubling the prefix ("เด็กชายเด็กชายขวัญชัย..."). This
// only prepends prefix when student_name doesn't already start with it, so
// display stays correct in both cases if that data convention ever changes.

/**
 * @param {{ prefix?: string|null, student_name?: string|null }|null|undefined} student
 */
export function formatStudentName(student) {
  const prefix = student?.prefix || '';
  const name = student?.student_name || '';
  if (!prefix || name.startsWith(prefix)) return name;
  return `${prefix}${name}`;
}
