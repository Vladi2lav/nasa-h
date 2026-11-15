from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as spice

from . import kernels
from .constants import (ABCORR, EARTH_RADIUS_KM, MOON_FRAME, MOON_RADIUS_KM,
                        SUN_RADIUS_KM)

UNIX_J2000_UTC_S = 946_728_000.0

WGS84_A_KM = 6378.137
WGS84_F = 1.0 / 298.257223563

EARTH_FIXED_FRAME = "ITRF93"
EARTH_FIXED_FALLBACK = "IAU_EARTH"
_ITRF93_CLASS_ID = 3000

BODIES = {"sun": ("SUN", SUN_RADIUS_KM), "earth": ("EARTH", EARTH_RADIUS_KM)}


def ms_to_et(t_ms):
    kernels.furnish()
    utc = np.asarray(t_ms, dtype=float) / 1000.0 - UNIX_J2000_UTC_S
    et = np.vectorize(lambda u: u + spice.deltet(u, "UTC"), otypes=[float])(utc)
    return float(et) if et.ndim == 0 else et


def iso_to_et(iso: str) -> float:
    return ms_to_et(iso_to_ms(iso))


def iso_to_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return round(dt.timestamp() * 1000)


def et_to_iso(et: float) -> str:
    kernels.furnish()
    return spice.et2utc(float(et), "ISOC", 3) + "Z"


def body_vector(body: str, et, frame: str = MOON_FRAME, abcorr: str = ABCORR):
    kernels.furnish()
    target = BODIES[body][0] if body in BODIES else body
    et = np.asarray(et, dtype=float)
    pos, _ = spice.spkpos(target, float(et) if et.ndim == 0 else et, frame, abcorr, "MOON")
    return np.asarray(pos)


def sun_vector(et):
    return body_vector("sun", et)


def earth_vector(et):
    return body_vector("earth", et)


def _itrf93_windows() -> list[tuple[float, float]]:
    kernels.furnish()
    windows = []
    for i in range(spice.ktotal("PCK")):
        path = spice.kdata(i, "PCK")[0]
        if not path.lower().endswith(".bpc"):
            continue
        ids = spice.cell_int(100)
        spice.pckfrm(path, ids)
        if _ITRF93_CLASS_ID not in list(ids):
            continue
        cover = spice.cell_double(2000)
        spice.pckcov(path, _ITRF93_CLASS_ID, cover)
        windows += [(cover[j], cover[j + 1]) for j in range(0, spice.card(cover), 2)]
    return windows


_itrf_cache: list[tuple[float, float]] | None = None


def earth_fixed_frame(et: float) -> str:
    global _itrf_cache
    if _itrf_cache is None:
        _itrf_cache = _itrf93_windows()
    return EARTH_FIXED_FRAME if any(a <= et <= b for a, b in _itrf_cache) else EARTH_FIXED_FALLBACK


def moon_vector_earth_fixed(et):
    kernels.furnish()
    et = np.asarray(et, dtype=float)
    flat = np.atleast_1d(et)
    frames = np.array([earth_fixed_frame(e) for e in flat])
    out = np.empty((flat.size, 3))
    for frame in np.unique(frames):
        sel = frames == frame
        pos, _ = spice.spkpos("MOON", flat[sel], str(frame), ABCORR, "EARTH")
        out[sel] = np.reshape(pos, (-1, 3))
    return out[0] if et.ndim == 0 else out


def moon_dir_earth_fixed(et):
    v = moon_vector_earth_fixed(et)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


@dataclass(frozen=True)
class SiteFrame:

    lat: float
    lon: float
    height_m: float
    pos: np.ndarray
    east: np.ndarray
    north: np.ndarray
    up: np.ndarray


def site_frame(lat_deg: float, lon_deg: float, height_m: float = 0.0) -> SiteFrame:
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    pos = (MOON_RADIUS_KM + height_m / 1000.0) * up
    return SiteFrame(float(lat_deg), float(lon_deg), float(height_m), pos, east, north, up)


def topocentric(frame: SiteFrame, body_vec_km, body_radius_km: float) -> dict:
    v = np.asarray(body_vec_km, dtype=float) - frame.pos
    rng = np.linalg.norm(v, axis=-1)
    e, n, u = v @ frame.east, v @ frame.north, v @ frame.up
    az = np.degrees(np.arctan2(e, n)) % 360.0
    el = np.degrees(np.arcsin(np.clip(u / rng, -1.0, 1.0)))
    ang = np.degrees(np.arcsin(np.clip(body_radius_km / rng, -1.0, 1.0)))
    return {"az": az, "el": el, "range_km": rng, "angular_radius_deg": ang}


def _exact_vector(frame: SiteFrame, target: str, et):
    kernels.furnish()
    flat = np.atleast_1d(np.asarray(et, dtype=float))
    out = np.array([spice.spkcpo(target, e, MOON_FRAME, "OBSERVER", ABCORR,
                                 frame.pos, "MOON", MOON_FRAME)[0][:3] for e in flat])
    return out[0] if np.ndim(et) == 0 else out


def sky(lat_deg: float, lon_deg: float, height_m: float, et, exact: bool = False) -> dict:
    frame = site_frame(lat_deg, lon_deg, height_m)
    result = {}
    for key, (target, radius) in BODIES.items():
        if exact:
            rel = _exact_vector(frame, target, et)
            result[key] = topocentric(frame, rel + frame.pos, radius)
        else:
            result[key] = topocentric(frame, body_vector(target, et), radius)
    return result


def sub_point(vec_km) -> tuple:
    v = np.asarray(vec_km, dtype=float)
    lat = np.degrees(np.arctan2(v[..., 2], np.hypot(v[..., 0], v[..., 1])))
    lon = np.degrees(np.arctan2(v[..., 1], v[..., 0]))
    return lat, lon


@dataclass(frozen=True)
class Station:

    lat: float
    lon: float
    alt_m: float = 0.0

    def ecef_km(self) -> np.ndarray:
        return np.array(spice.georec(np.radians(self.lon), np.radians(self.lat),
                                     self.alt_m / 1000.0, WGS84_A_KM, WGS84_F))

    def up(self) -> np.ndarray:
        la, lo = np.radians(self.lat), np.radians(self.lon)
        return np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def station_elevation(station: Station, moon_vec_earth_fixed_km) -> np.ndarray:
    v = np.asarray(moon_vec_earth_fixed_km, dtype=float) - station.ecef_km()
    return np.degrees(np.arcsin(np.clip((v @ station.up()) / np.linalg.norm(v, axis=-1), -1, 1)))


def station_elevation_exact(station: Station, et) -> np.ndarray:
    kernels.furnish()
    pos, up = station.ecef_km(), station.up()
    flat = np.atleast_1d(np.asarray(et, dtype=float))
    out = np.empty(flat.size)
    for i, e in enumerate(flat):
        frame = earth_fixed_frame(e)
        v = np.array(spice.spkcpo("MOON", e, frame, "OBSERVER", ABCORR, pos, "EARTH", frame)[0][:3])
        out[i] = np.degrees(np.arcsin(v @ up / np.linalg.norm(v)))
    return out[0] if np.ndim(et) == 0 else out


EPHEM_FORMAT = "lunarnav-ephem-1"
EPHEM_STEP_S = 3600
EPHEM_CHUNK_LEN = 8192
EPHEM_PAD = 2
EPHEM_COVERAGE_UTC = ("1969-01-01", "2060-01-01")
EPHEM_FIELDS = ("sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z",
                "mef_x", "mef_y", "mef_z")
TAI_MINUS_UTC_S = 37


def ephem_grid_t0() -> float:
    start = iso_to_et(EPHEM_COVERAGE_UTC[0] + "T00:00:00Z")
    return float(np.floor(start / EPHEM_STEP_S) * EPHEM_STEP_S)


def ephem_samples(et) -> np.ndarray:
    et = np.atleast_1d(np.asarray(et, dtype=float))
    return np.hstack([sun_vector(et), earth_vector(et), moon_dir_earth_fixed(et)])


def build_web_ephemeris(out_dir, verbose: bool = True) -> dict:
    names = kernels.furnish(verbose=verbose)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = ephem_grid_t0()
    et_end = iso_to_et(EPHEM_COVERAGE_UTC[1] + "T00:00:00Z")
    last_chunk = int(np.floor((et_end - t0) / EPHEM_STEP_S)) // EPHEM_CHUNK_LEN
    k = np.arange(-EPHEM_PAD, (last_chunk + 1) * EPHEM_CHUNK_LEN + EPHEM_PAD)
    if verbose:
        print(f"sampling {k.size} epochs ({last_chunk + 1} chunks)", flush=True)
    data = ephem_samples(t0 + k * float(EPHEM_STEP_S)).astype("<f4")

    for old in out.glob("c*.bin"):
        old.unlink()
    rec = EPHEM_CHUNK_LEN + 2 * EPHEM_PAD
    for chunk in range(last_chunk + 1):
        start = chunk * EPHEM_CHUNK_LEN
        (out / f"c{chunk}.bin").write_bytes(data[start:start + rec].tobytes())

    index = {
        "format": EPHEM_FORMAT,
        "t0_et": t0,
        "step_s": EPHEM_STEP_S,
        "chunk_len": EPHEM_CHUNK_LEN,
        "pad": EPHEM_PAD,
        "first_chunk": 0,
        "last_chunk": last_chunk,
        "fields": list(EPHEM_FIELDS),
        "tai_minus_utc": TAI_MINUS_UTC_S,
        "kernels": names,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage_utc": list(EPHEM_COVERAGE_UTC),
        "frames": {"moon": MOON_FRAME, "earth_fixed": EARTH_FIXED_FRAME,
                   "earth_fixed_fallback": EARTH_FIXED_FALLBACK},
        "abcorr": ABCORR,
        "units": {"sun": "km", "earth": "km", "mef": "unit vector"},
    }
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return index
