from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
import spiceypy as spice

from . import ephemeris as E
from . import kernels
from .constants import (EARTH_RADIUS_KM, FIXTURE_DIR, MOON_RADIUS_KM, RAW_DIR, ROOT,
                        SUN_RADIUS_KM)

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_CACHE = RAW_DIR / "horizons_cache"
REPORT_PATH = ROOT / "docs" / "VALIDATION_EPHEMERIS.md"
FIXTURE_PATH = FIXTURE_DIR / "ephem_reference.json"
AU_KM = 149_597_870.7
TARGET_TOLERANCE_DEG = 0.01


@dataclass(frozen=True)
class Site:

    name: str
    lat: float
    lon: float
    height_m: float = 0.0


VALIDATION_SITES = (
    Site("Apollo 11", 0.67416, 23.47314),
    Site("Apollo 17", 20.1908, 30.7717),
    Site("Shackleton rim", -89.78, -155.7),
    Site("Malapert / IM-1", -80.13, 1.44),
    Site("Chandrayaan-3", -69.373, 32.319),
    Site("Chang'e 4", -45.444, 177.599),
    Site("Peary rim (north pole)", 88.6, 33.0),
)

VALIDATION_TIMES_UTC = (
    "1969-07-20T20:17:40Z", "1972-12-11T19:54:57Z", "1979-03-05T06:00:00Z",
    "1987-10-17T12:30:00Z", "1994-07-16T20:00:00Z", "2000-01-01T12:00:00Z",
    "2008-05-29T03:15:00Z", "2016-12-31T23:59:59Z", "2019-01-03T02:26:00Z",
    "2023-08-23T12:33:00Z", "2024-02-22T23:23:00Z", "2031-06-10T09:00:00Z",
    "2040-12-31T18:00:00Z",
)

HORIZONS_IDS = {"sun": "10", "earth": "399"}


def _horizons_params(site: Site, target: str, times_ms) -> dict:
    jd = [f"{t / 86_400_000 + 2_440_587.5:.9f}" for t in times_ms]
    q = lambda v: f"'{v}'"
    return {
        "format": "json",
        "COMMAND": q(HORIZONS_IDS[target]),
        "OBJ_DATA": q("NO"),
        "MAKE_EPHEM": q("YES"),
        "EPHEM_TYPE": q("OBSERVER"),
        "CENTER": q("coord@301"),
        "COORD_TYPE": q("GEODETIC"),
        "SITE_COORD": q(f"{site.lon},{site.lat},{site.height_m / 1000.0}"),
        "TLIST": " ".join(f"'{j}'" for j in jd),
        "TLIST_TYPE": q("JD"),
        "TIME_TYPE": q("UT"),
        "QUANTITIES": q("4,20"),
        "ANG_FORMAT": q("DEG"),
        "APPARENT": q("AIRLESS"),
        "CSV_FORMAT": q("YES"),
        "EXTRA_PREC": q("YES"),
    }


def horizons_query(site: Site, target: str, times_ms) -> dict:
    params = _horizons_params(site, target, times_ms)
    key = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:24]
    cache = HORIZONS_CACHE / f"{key}.json"
    if cache.exists():
        result = json.loads(cache.read_text(encoding="utf-8"))["result"]
    else:
        resp = requests.post(HORIZONS_URL, data=params, timeout=120,
                             headers={"User-Agent": kernels.USER_AGENT})
        resp.raise_for_status()
        body = resp.json()
        if "result" not in body or "$$SOE" not in body["result"]:
            raise RuntimeError(f"Horizons error: {body.get('error') or body.get('result', '')[:500]}")
        result = body["result"]
        HORIZONS_CACHE.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"params": params, "result": result}), encoding="utf-8")
    head, rest = result.split("$$SOE", 1)
    rows = [r for r in rest.split("$$EOE", 1)[0].strip().splitlines() if r.strip()]
    if len(rows) != len(times_ms):
        raise RuntimeError(f"Horizons returned {len(rows)} rows for {len(times_ms)} epochs")
    cols = [[c.strip() for c in r.split(",")] for r in rows]
    return {
        "az": np.array([float(c[3]) for c in cols]),
        "el": np.array([float(c[4]) for c in cols]),
        "range_km": np.array([float(c[5]) * AU_KM for c in cols]),
        "header": head,
    }


def _wrap180(d):
    return (np.asarray(d) + 180.0) % 360.0 - 180.0


def _separation_deg(az1, el1, az2, el2):
    a1, e1, a2, e2 = map(np.radians, (az1, el1, az2, el2))
    c = np.sin(e1) * np.sin(e2) + np.cos(e1) * np.cos(e2) * np.cos(a1 - a2)
    s = np.hypot(np.cos(e2) * np.sin(a1 - a2),
                 np.cos(e1) * np.sin(e2) - np.sin(e1) * np.cos(e2) * np.cos(a1 - a2))
    return np.degrees(np.arctan2(s, c))


def compare_with_horizons(sites=VALIDATION_SITES, times_utc=VALIDATION_TIMES_UTC) -> list[dict]:
    times_ms = [E.iso_to_ms(t) for t in times_utc]
    et = E.ms_to_et(np.array(times_ms, dtype=float))
    rows = []
    for site in sites:
        ours = E.sky(site.lat, site.lon, site.height_m, et)
        exact = E.sky(site.lat, site.lon, site.height_m, et, exact=True)
        for body in ("sun", "earth"):
            hz = horizons_query(site, body, times_ms)
            o = ours[body]
            sep = _separation_deg(o["az"], o["el"], hz["az"], hz["el"])
            x = exact[body]
            sep_x = _separation_deg(x["az"], x["el"], hz["az"], hz["el"])
            for i, t in enumerate(times_utc):
                rows.append({
                    "site": site.name, "body": body, "utc": t,
                    "az": float(o["az"][i]), "el": float(o["el"][i]),
                    "hz_az": float(hz["az"][i]), "hz_el": float(hz["el"][i]),
                    "d_az": float(_wrap180(o["az"][i] - hz["az"][i])),
                    "d_el": float(o["el"][i] - hz["el"][i]),
                    "d_sep": float(sep[i]),
                    "d_sep_exact": float(sep_x[i]),
                    "d_range_km": float(o["range_km"][i] - hz["range_km"][i]),
                })
    return rows


def parallax_mode_difference(sites=VALIDATION_SITES, n_epochs: int = 60, seed: int = 1) -> dict:
    rng = np.random.default_rng(seed)
    lo, hi = E.iso_to_et("1969-01-01T00:00:00Z"), E.iso_to_et("2059-12-31T00:00:00Z")
    et = np.sort(rng.uniform(lo, hi, n_epochs))
    out = {"sun": 0.0, "earth": 0.0, "station": 0.0}
    for s in sites:
        a = E.sky(s.lat, s.lon, s.height_m, et)
        b = E.sky(s.lat, s.lon, s.height_m, et, exact=True)
        for body in ("sun", "earth"):
            sep = _separation_deg(a[body]["az"], a[body]["el"], b[body]["az"], b[body]["el"])
            out[body] = max(out[body], float(np.max(sep)))
    mv = E.moon_vector_earth_fixed(et)
    for st in DSN_STATIONS.values():
        d = E.station_elevation(st, mv) - E.station_elevation_exact(st, et)
        out["station"] = max(out["station"], float(np.max(np.abs(d))))
    return out


def me_pa_rotation_deg(et: float = 0.0) -> float:
    kernels.furnish()
    m = np.array(spice.pxform("MOON_PA_DE440", "MOON_ME", et))
    return float(np.degrees(np.arccos(np.clip((np.trace(m) - 1.0) / 2.0, -1.0, 1.0))))


def _stats(rows, key):
    v = np.array([r[key] for r in rows])
    return float(np.max(np.abs(v))), float(np.sqrt(np.mean(v ** 2)))


def format_table(rows) -> str:
    lines = [f"{'site':<24}{'body':<6}{'UTC':<22}{'az':>11}{'el':>10}"
             f"{'d_az':>10}{'d_el':>10}{'d_sep':>10}{'d_range':>10}"]
    for r in rows:
        lines.append(f"{r['site']:<24}{r['body']:<6}{r['utc']:<22}{r['az']:11.5f}{r['el']:10.5f}"
                     f"{r['d_az']:10.6f}{r['d_el']:10.6f}{r['d_sep']:10.6f}{r['d_range_km']:10.3f}")
    return "\n".join(lines)


def write_report(rows, parallax: dict, path: Path = REPORT_PATH) -> str:
    names = kernels.furnish()
    summary = []
    for body in ("sun", "earth"):
        sub = [r for r in rows if r["body"] == body]
        (maz, raz), (mel, rel), (msep, rsep), (mx, rx), (mrg, rrg) = (
            _stats(sub, k) for k in ("d_az", "d_el", "d_sep", "d_sep_exact", "d_range_km"))
        late = [r for r in sub if r["utc"] >= "1972"]
        (mx72, rx72) = _stats(late, "d_sep_exact")
        summary.append(f"| {body.capitalize()} | {len(sub)} | {maz:.6f} / {raz:.6f} | "
                       f"{mel:.6f} / {rel:.6f} | {msep:.6f} / {rsep:.6f} | "
                       f"{mx:.6f} / {rx:.6f} | {mx72:.2e} / {rx72:.2e} | {mrg:.3f} / {rrg:.3f} |")
    worst = max(r["d_sep"] for r in rows)
    pre72 = max((r["d_sep"] for r in rows if r["utc"] < "1972"), default=0.0)
    post72 = max((r["d_sep"] for r in rows if r["utc"] >= "1972"), default=0.0)
    pa_me = me_pa_rotation_deg()
    pa_me_m = np.radians(pa_me) * MOON_RADIUS_KM * 1000.0
    verdict = "PASS" if worst < TARGET_TOLERANCE_DEG else "FAIL"
    detail = "\n".join(
        f"| {r['site']} | {r['body']} | {r['utc']} | {r['az']:.5f} | {r['el']:.5f} | "
        f"{r['d_az']:+.6f} | {r['d_el']:+.6f} | {r['d_sep']:.6f} |" for r in rows)
    sites = "\n".join(f"| {s.name} | {s.lat:+.5f} | {s.lon:+.5f} |" for s in VALIDATION_SITES)
    text = f"""# Ephemeris validation — lunarnav vs JPL Horizons

Generated by `python -m lunarnav validate-horizons` on
{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.

**Result: {verdict}** — largest angular difference {worst:.6f}° (target < {TARGET_TOLERANCE_DEG}°).

## Method

* **lunarnav**: SPICE kernels {', '.join(f'`{n}`' for n in names)}. Sun / Earth centre
  relative to the Moon centre in `MOON_ME`, aberration `LT+S`, site offset on the
  1737.4 km sphere applied geometrically (the web-engine contract,
  docs/ARCHITECTURE.md §3).
* **JPL Horizons API**: `CENTER='coord@301'`, `COORD_TYPE='GEODETIC'`,
  `SITE_COORD='lon,lat,0'`, quantity 4 (apparent azimuth / elevation) and 20 (range),
  `APPARENT='AIRLESS'` (no refraction), times as `TLIST` Julian dates in UT.
  Horizons reports the lunar site frame as `MEAN_ME (high precision)` on a 1737.4 km
  sphere and measures azimuth clockwise from north (N 0°, E 90°), elevation from the
  plane perpendicular to the local zenith — identical conventions, so no conversion
  is applied. Responses are cached in `data_raw/horizons_cache/`.
* `d_sep` is the great-circle angle between the two directions; `d_az`, `d_el` are
  lunarnav minus Horizons (`d_az` wrapped to ±180°; near the zenith or at the pole
  azimuth differences are geometrically amplified, `d_sep` is the meaningful figure).

## Sites

| Site | Lat (°) | Lon E (°) |
|---|---|---|
{sites}

Epochs (UTC): {', '.join(VALIDATION_TIMES_UTC)}.

## Summary (max / RMS)

Contract mode (`d_az`, `d_el`, `d_sep`) and exact observer mode (`d_sep exact`; also
restricted to epochs from 1972 on, where both sides use the same UTC scale):

| Body | N | d_az (°) | d_el (°) | d_sep (°) | d_sep exact (°) | d_sep exact ≥ 1972 (°) | d_range (km) |
|---|---|---|---|---|---|---|---|
{chr(10).join(summary)}

## Differences explained

* **Before 1972 (UTC time scale):** Horizons converts the requested UT with the
  historical "rubber-second" UTC (TAI−UTC ≈ 7.6 s in July 1969), while the SPICE
  leap-second kernel applies TAI−UTC = 9 s to every pre-1972 epoch. The same UTC label
  therefore denotes instants ≈ 1.4 s apart; the Sun moves ≈ 0.51°/h in the lunar sky,
  i.e. ≈ 2·10⁻⁴°. This is the largest residual ({pre72:.6f}° max for the 1969 rows).
  From 1972 on (integer leap seconds) the maximum is {post72:.6f}°.
* **Earth residual of the contract mode (≈ 2·10⁻⁵°)** is the contract's own
  approximation (stellar aberration applied along the Moon-centre direction, see the
  next section): in exact observer mode lunarnav agrees with Horizons to the
  milliarcsecond level, although Horizons uses DE441 (lunarnav DE440) and applies
  gravitational light deflection, which SPICE `LT+S` omits.
* **Frame choice matters:** the constant rotation between `MOON_PA_DE440` (principal
  axes) and `MOON_ME` is {pa_me:.4f}° (≈ {pa_me_m:.0f} m on the surface). Using the PA
  frame for site coordinates would produce errors of that size — the classic cause of
  disagreement — which this comparison rules out.
* **Range:** Horizons `delta` is the light-time-aberrated range; differences of
  ≤ ~1 km (Sun) and ≤ ~0.3 km (Earth) do not affect directions.

## Contract mode vs exact observer

Maximum angular difference between the contract mode (Moon-centre apparent vectors +
geometric site offset) and SPICE solving light time and stellar aberration for the
surface observer itself (`spkcpo`), {len(VALIDATION_SITES)} sites × 60 epochs 1969–2060:

| Quantity | Max difference (°) |
|---|---|
| Sun direction | {parallax['sun']:.2e} |
| Earth direction | {parallax['earth']:.2e} |
| Moon elevation at DSN stations (geometric station offset vs observer at station) | {parallax['station']:.2e} |

The residual is second order: stellar aberration (≈ v/c ≈ 10⁻⁴ rad) is applied along
the Moon-centre direction instead of the topocentric one, which differs by the parallax
(≤ 0.26° for the Earth seen from the Moon, ≤ 0.95° for the Moon seen from an Earth
station), plus the observer's rotational velocity (4.6 m/s on the Moon, up to
0.46 km/s at an Earth station). Negligible for this application (the solar disc is
0.53° wide).

## All rows

| Site | Body | UTC | Az (°) | El (°) | d_az (°) | d_el (°) | d_sep (°) |
|---|---|---|---|---|---|---|---|
{detail}
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return text


DSN_STATIONS = {
    "goldstone": E.Station(35.4267, -116.89, 1001.0),
    "madrid": E.Station(40.4314, -4.2481, 865.0),
    "canberra": E.Station(-35.4014, 148.9817, 689.0),
}

FIXTURE_SITES = VALIDATION_SITES + (
    Site("Apollo 15", 26.1322, 3.6339),
    Site("Luna 9", 7.08, -64.37),
    Site("Chang'e 5", 43.06, -51.92),
    Site("Connecting ridge (mast 1.5 km above R)", -89.45, -137.31, 1500.0),
    Site("Near-side equator, -2 km", 0.0, 0.0, -2000.0),
)


def fixture_times_ms(n_random: int = 24, seed: int = 7) -> list[int]:
    rng = np.random.default_rng(seed)
    t_lo, t_hi = E.iso_to_ms("1969-01-01T00:00:00Z"), E.iso_to_ms("2059-12-31T00:00:00Z")
    times = [int(t) for t in rng.integers(t_lo, t_hi, n_random)]
    times += [E.iso_to_ms(s) for s in (
        "1969-01-01T00:00:00Z", "1969-07-20T20:17:40Z", "1971-12-31T23:59:59Z",
        "1972-01-01T00:00:00Z", "1972-07-01T00:00:00.500Z", "1990-01-01T00:00:01Z",
        "2016-12-31T23:59:59Z", "2017-01-01T00:00:00Z", "2059-12-31T23:00:00Z",
        "2060-01-01T00:00:00Z")]
    t0 = E.ephem_grid_t0()
    for chunk in (1, 40, 97):
        et_b = t0 + chunk * E.EPHEM_CHUNK_LEN * E.EPHEM_STEP_S
        for off in (-1440.0, 1080.0):
            times.append(E.iso_to_ms(E.et_to_iso(et_b + off)))
    return sorted(set(times))


def build_fixture(path: Path = FIXTURE_PATH) -> dict:
    names = kernels.furnish()
    times = fixture_times_ms()
    et = E.ms_to_et(np.array(times, dtype=float))
    sun, earth = E.sun_vector(et), E.earth_vector(et)
    mev = E.moon_vector_earth_fixed(et)
    mef = mev / np.linalg.norm(mev, axis=1, keepdims=True)
    epochs = []
    for i, t in enumerate(times):
        sub_s, sub_e = E.sub_point(sun[i]), E.sub_point(earth[i])
        epochs.append({
            "tMs": t, "utc": E.et_to_iso(et[i]), "et": float(et[i]),
            "earthFixedFrame": E.earth_fixed_frame(et[i]),
            "sun": sun[i].tolist(), "earth": earth[i].tolist(), "mef": mef[i].tolist(),
            "subSolar": {"lat": float(sub_s[0]), "lon": float(sub_s[1])},
            "subEarth": {"lat": float(sub_e[0]), "lon": float(sub_e[1])},
            "stationElevationDeg": {k: float(E.station_elevation(st, mev[i]))
                                    for k, st in DSN_STATIONS.items()},
        })
    sites = []
    for s in FIXTURE_SITES:
        f = E.site_frame(s.lat, s.lon, s.height_m)
        res = {}
        for body, vec, radius in (("sun", sun, SUN_RADIUS_KM), ("earth", earth, EARTH_RADIUS_KM)):
            tp = E.topocentric(f, vec, radius)
            res[body] = {"az": tp["az"].tolist(), "el": tp["el"].tolist(),
                         "rangeKm": tp["range_km"].tolist(),
                         "angularRadiusDeg": tp["angular_radius_deg"].tolist()}
        sites.append({"name": s.name, "lat": s.lat, "lon": s.lon, "heightM": s.height_m,
                      "pos": f.pos.tolist(), "east": f.east.tolist(),
                      "north": f.north.tolist(), "up": f.up.tolist(), **res})
    fixture = {
        "format": "lunarnav-ephem-fixture-1",
        "description": "Reference values from Python/SPICE (lunarnav.ephemeris), contract mode: "
                       "MOON_ME, LT+S from the Moon centre, geometric site offset. Arrays in "
                       "each site follow the order of 'epochs'. Degrees, km.",
        "kernels": names,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stations": {k: {"lat": st.lat, "lon": st.lon, "alt_m": st.alt_m}
                     for k, st in DSN_STATIONS.items()},
        "epochs": epochs,
        "sites": sites,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, indent=1) + "\n", encoding="utf-8")
    return fixture
