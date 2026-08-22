// geo.js — small, dependency-free geographic helpers shared by the exam
// proximity-check feature (StudentExamTool capturing a one-time location,
// ExamMonitorTool flagging students sitting too close together).

const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance between two lat/lng points, in meters (Haversine
 * formula) — accurate enough for the short (tens-to-hundreds of meters)
 * distances this feature cares about; no need for a more precise
 * ellipsoidal model at this scale.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}
