export const MOON_RADIUS_KM = 1737.4;
export const SUN_RADIUS_KM = 695700.0;
export const EARTH_RADIUS_KM = 6378.137;

const WGS84_A_KM = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const ZERO3 = Object.freeze([0, 0, 0]);

export function siteFrame(latDeg, lonDeg, heightM = 0) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  const cla = Math.cos(la), sla = Math.sin(la), clo = Math.cos(lo), slo = Math.sin(lo);
  const r = MOON_RADIUS_KM + heightM / 1000;
  return {
    lat: latDeg, lon: lonDeg, heightM,
    pos: Float64Array.of(r * cla * clo, r * cla * slo, r * sla),
    east: Float64Array.of(-slo, clo, 0),
    north: Float64Array.of(-sla * clo, -sla * slo, cla),
    up: Float64Array.of(cla * clo, cla * slo, sla),
  };
}

export function topocentricInto(frame, v, bodyRadiusKm, out) {
  const p = frame.pos;
  const dx = v[0] - p[0], dy = v[1] - p[1], dz = v[2] - p[2];
  const rng = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const e = frame.east, n = frame.north, u = frame.up;
  const de = dx * e[0] + dy * e[1] + dz * e[2];
  const dn = dx * n[0] + dy * n[1] + dz * n[2];
  const du = dx * u[0] + dy * u[1] + dz * u[2];
  let az = Math.atan2(de, dn) * RAD;
  if (az < 0) az += 360;
  out[0] = az;
  out[1] = Math.asin(Math.max(-1, Math.min(1, du / rng))) * RAD;
  out[2] = rng;
  out[3] = Math.asin(Math.min(1, bodyRadiusKm / rng)) * RAD;
  return out;
}

export function elevationDeg(frame, v) {
  const p = frame.pos, u = frame.up;
  const dx = v[0] - p[0], dy = v[1] - p[1], dz = v[2] - p[2];
  const du = dx * u[0] + dy * u[1] + dz * u[2];
  return Math.asin(du / Math.sqrt(dx * dx + dy * dy + dz * dz)) * RAD;
}

export function topocentric(frame, bodyVecKm, bodyRadiusKm) {
  const o = topocentricInto(frame, bodyVecKm, bodyRadiusKm, [0, 0, 0, 0]);
  return { az: o[0], el: o[1], rangeKm: o[2], angularRadiusDeg: o[3] };
}

export function subPoint(vecKm) {
  const x = vecKm[0], y = vecKm[1], z = vecKm[2];
  return { lat: Math.atan2(z, Math.hypot(x, y)) * RAD, lon: Math.atan2(y, x) * RAD };
}

export function stationFrame(station) {
  const la = station.lat * DEG, lo = station.lon * DEG;
  const h = (station.alt_m || 0) / 1000;
  const cla = Math.cos(la), sla = Math.sin(la), clo = Math.cos(lo), slo = Math.sin(lo);
  const nRad = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sla * sla);
  return {
    pos: Float64Array.of((nRad + h) * cla * clo, (nRad + h) * cla * slo,
                         (nRad * (1 - WGS84_E2) + h) * sla),
    up: Float64Array.of(cla * clo, cla * slo, sla),
  };
}

export function stationElevation(station, moonVec) {
  const f = station.pos ? station : stationFrame(station);
  const norm = Math.hypot(moonVec[0], moonVec[1], moonVec[2]);
  const p = norm > 2 ? f.pos : ZERO3;
  const dx = moonVec[0] - p[0], dy = moonVec[1] - p[1], dz = moonVec[2] - p[2];
  const du = dx * f.up[0] + dy * f.up[1] + dz * f.up[2];
  return Math.asin(du / Math.sqrt(dx * dx + dy * dy + dz * dz)) * RAD;
}
