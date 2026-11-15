from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np
from numba import njit, prange
from numba.typed import List as NumbaList

from .constants import DEFAULT_OBSERVER_HEIGHT_M, MOON_RADIUS_M, WEB_DATA_DIR
from . import dem as demmod

H_MAX_M = 11_000.0
DEFAULT_AZ_STEP_DEG = 0.5
DEFAULT_MAX_RANGE_KM = 400.0
STEP_FRACTION = 0.5

POLAR_FINE_LIMIT_M = 30_000.0
POLAR_MID_LIMIT_M = 100_000.0
WEB_POLAR_TIER_MIN_ABS_LAT = 60.0


@dataclass(frozen=True)
class Tier:

    raster: demmod.Raster
    max_dist_m: float = math.inf
    step_m: float = 0.0

    @property
    def step(self) -> float:
        return self.step_m or STEP_FRACTION * self.raster.resolution_m


@dataclass
class HorizonProfile:

    lat: float
    lon: float
    terrain_height_m: float
    observer_height_m: float
    az_step_deg: float
    elev_deg: np.ndarray
    max_range_km: float
    source: str
    compute_s: float = 0.0

    def elevation_at(self, az_deg):
        n = len(self.elev_deg)
        x = np.mod(np.asarray(az_deg, dtype=np.float64), 360.0) / self.az_step_deg
        i0 = np.floor(x).astype(np.int64) % n
        f = x - np.floor(x)
        return self.elev_deg[i0] * (1 - f) + self.elev_deg[(i0 + 1) % n] * f

    def to_json(self, site_id: str | None = None) -> dict:
        return {
            "format": "lunarnav-horizon-1", "site_id": site_id,
            "lat": round(float(self.lat), 6), "lon": round(float(self.lon), 6),
            "terrain_height_m": round(float(self.terrain_height_m), 1),
            "observer_height_m": float(self.observer_height_m),
            "az_step_deg": float(self.az_step_deg),
            "elev_deg": [round(float(v), 2) for v in self.elev_deg],
            "max_range_km": round(float(self.max_range_km), 1),
            "source": self.source,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }


@njit(cache=True, inline="always")
def _sample(data, p, px, py, pz):
    proj = p[0]
    w = int(p[6])
    h = int(p[7])
    if proj == 0.0:
        lat = math.degrees(math.asin(min(1.0, max(-1.0, pz))))
        lon = math.degrees(math.atan2(py, px))
        row = (p[3] - lat) * p[5] - 0.5
        col = ((lon - p[4]) % 360.0) * p[5] - 0.5
        if row < 0.0:
            row = 0.0
        elif row > h - 1.0:
            row = h - 1.0
        if p[8] == 0.0 and not (col >= 0.0 and col <= w - 1.0):
            return np.nan
    else:
        if proj == 1.0:
            k = 2.0 * p[10] / (1.0 - pz)
            x = k * py
            y = k * px
        else:
            k = 2.0 * p[10] / (1.0 + pz)
            x = k * py
            y = -k * px
        row = (p[4] - y) / p[5]
        col = (x - p[3]) / p[5]
        if not (row >= 0.0 and row <= h - 1.0 and col >= 0.0 and col <= w - 1.0):
            return np.nan
    r0 = int(math.floor(row))
    if r0 > h - 2:
        r0 = h - 2
    fr = row - r0
    c0f = math.floor(col)
    fc = col - c0f
    c0 = int(c0f)
    if p[8] != 0.0:
        c0 = c0 % w
        c1 = (c0 + 1) % w
    else:
        if c0 > w - 2:
            c0 = w - 2
            fc = col - c0
        c1 = c0 + 1
    v00 = float(data[r0, c0])
    v01 = float(data[r0, c1])
    v10 = float(data[r0 + 1, c0])
    v11 = float(data[r0 + 1, c1])
    nd = p[9]
    if nd == nd and (v00 == nd or v01 == nd or v10 == nd or v11 == nd):
        return np.nan
    v = (v00 * (1.0 - fc) + v01 * fc) * (1.0 - fr) + (v10 * (1.0 - fc) + v11 * fc) * fr
    return v * p[1] + p[2]


@njit(cache=True)
def _height_at(datas, params, px, py, pz):
    for k in range(len(datas)):
        v = _sample(datas[k], params[k], px, py, pz)
        if v == v:
            return v, k
    return np.nan, -1


@njit(cache=True, parallel=True)
def _horizon_kernel(lat0, lon0, r_obs, az_deg, datas, params, max_dist, steps,
                    d0, max_range, radius, r_max):
    n_az = az_deg.shape[0]
    n_t = len(datas)
    best_out = np.empty(n_az)
    reach = np.empty(n_az)
    used = np.zeros((n_az, n_t), dtype=np.int64)
    phi = math.radians(lat0)
    lam = math.radians(lon0)
    sp, cp, sl, cl = math.sin(phi), math.cos(phi), math.sin(lam), math.cos(lam)
    ux, uy, uz = cp * cl, cp * sl, sp
    nx, ny, nz = -sp * cl, -sp * sl, cp
    ex, ey = -sl, cl
    for i in prange(n_az):
        a = math.radians(az_deg[i])
        ca, sa = math.cos(a), math.sin(a)
        tx = ca * nx + sa * ex
        ty = ca * ny + sa * ey
        tz = ca * nz
        best = -1e300
        d = d0
        last = d0
        while d <= max_range:
            th = d / radius
            ct, st = math.cos(th), math.sin(th)
            if r_max * ct - r_obs <= best * r_max * st:
                break
            px = ct * ux + st * tx
            py = ct * uy + st * ty
            pz = ct * uz + st * tz
            step = steps[n_t - 1]
            for k in range(n_t):
                if d < max_dist[k]:
                    v = _sample(datas[k], params[k], px, py, pz)
                    if v == v:
                        r = radius + v
                        t = (r * ct - r_obs) / (r * st)
                        if t > best:
                            best = t
                        used[i, k] += 1
                        step = steps[k]
                        break
            last = d
            d += step
        best_out[i] = best
        reach[i] = last
    return best_out, reach, used.sum(axis=0)


_tier_cache: dict = {}


def _cached(key, fn):
    if key not in _tier_cache:
        _tier_cache[key] = fn()
    return _tier_cache[key]


def highres_tiers(lat: float) -> list[Tier]:
    tiers = []
    if abs(lat) > 65.0:
        pole = "S" if lat < 0 else "N"
        fine = _cached(("polar", pole), lambda: demmod.polar_dem(pole))
        mid = _cached(("polar60", pole), lambda: demmod.block_mean(fine, 3, f"{fine.name.lower()}_x3"))
        far = _cached(("polar240", pole), lambda: demmod.polar_240(fine))
        mid.name = f"{fine.name} 3x3 mean"
        tiers += [Tier(fine, POLAR_FINE_LIMIT_M), Tier(mid, POLAR_MID_LIMIT_M), Tier(far)]
    tiers.append(Tier(_cached("global", demmod.global_dem)))
    return tiers


def web_rasters() -> dict:
    def load():
        out = {}
        for key in ("south", "north", "global"):
            hdr = WEB_DATA_DIR / "dem" / f"{key}.json"
            if hdr.exists():
                r = demmod.Raster.from_header(hdr)
                r.name = f"web {key}"
                out[key] = r
        return out
    return _cached("web", load)


def web_tiers(lat: float) -> list[Tier]:
    grids = web_rasters()
    tiers = []
    polar = grids.get("south" if lat < 0 else "north")
    if polar is not None and abs(lat) >= WEB_POLAR_TIER_MIN_ABS_LAT:
        tiers.append(Tier(polar))
    tiers.append(Tier(grids["global"]))
    return tiers


def height_at(lat: float, lon: float, tiers: list[Tier]) -> tuple[float, int]:
    phi, lam = math.radians(lat), math.radians(lon)
    datas = NumbaList([np.asarray(t.raster.data) for t in tiers])
    params = np.stack([t.raster.kernel_params() for t in tiers])
    return _height_at(datas, params, math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam),
                      math.sin(phi))


def compute_horizon(lat: float, lon: float, *, tiers: list[Tier] | None = None,
                    observer_height_m: float = DEFAULT_OBSERVER_HEIGHT_M,
                    az_step_deg: float = DEFAULT_AZ_STEP_DEG,
                    max_range_km: float = DEFAULT_MAX_RANGE_KM,
                    min_range_km: float = 0.0,
                    resolution: str = "high") -> HorizonProfile:
    t_start = time.perf_counter()
    lat = float(lat)
    lon = float((lon + 180.0) % 360.0 - 180.0)
    if tiers is None:
        tiers = highres_tiers(lat) if resolution == "high" else web_tiers(lat)
    n_az = int(round(360.0 / az_step_deg))
    if abs(n_az * az_step_deg - 360.0) > 1e-9:
        raise ValueError("360 must be an integer multiple of az_step_deg")
    datas = NumbaList([np.asarray(t.raster.data) for t in tiers])
    params = np.stack([t.raster.kernel_params() for t in tiers])
    steps = np.array([t.step for t in tiers])
    max_dist = np.array([t.max_dist_m for t in tiers])
    h_site, k_site = height_at(lat, lon, tiers)
    if k_site < 0:
        raise ValueError(f"no elevation data at lat={lat}, lon={lon}")
    r_obs = MOON_RADIUS_M + h_site + observer_height_m
    az = np.arange(n_az) * az_step_deg
    best, reach, used = _horizon_kernel(lat, lon, r_obs, az, datas, params, max_dist, steps,
                                        max(steps[k_site], min_range_km * 1000.0), max_range_km * 1000.0, MOON_RADIUS_M,
                                        MOON_RADIUS_M + H_MAX_M)
    elev = np.degrees(np.arctan(best))
    parts = []
    for t, n in zip(tiers, used):
        if n:
            lim = f" (<{t.max_dist_m / 1000:.0f} km)" if math.isfinite(t.max_dist_m) else ""
            parts.append(f"{t.raster.describe()}{lim}")
    source = "LOLA " + " + ".join(parts)
    return HorizonProfile(lat=lat, lon=lon, terrain_height_m=float(h_site),
                          observer_height_m=float(observer_height_m), az_step_deg=float(az_step_deg),
                          elev_deg=elev, max_range_km=float(reach.max()) / 1000.0, source=source,
                          compute_s=time.perf_counter() - t_start)


def sphere_dip_deg(height_m: float, radius_m: float = MOON_RADIUS_M) -> float:
    return -math.degrees(math.acos(radius_m / (radius_m + height_m)))
