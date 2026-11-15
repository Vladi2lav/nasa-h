import datetime as dt
import json
import re

import numpy as np
import requests
import spiceypy as sp

from . import kernels
from .constants import MOON_FRAME, WEB_DATA_DIR

API = "https://ssd.jpl.nasa.gov/api/horizons.api"

CRAFT = [
    {"id": "lro", "horizons": "-85", "name": "Lunar Reconnaissance Orbiter", "agency": "NASA",
     "info": "Polar mapping orbit since 2009; source of the LOLA and LROC data used by this tool."},
    {"id": "kplo", "horizons": "-155", "name": "Danuri (KPLO)", "agency": "KARI / KASA",
     "info": "Korea Pathfinder Lunar Orbiter, in lunar orbit since December 2022."},
    {"id": "chandrayaan-2", "horizons": "-152", "name": "Chandrayaan-2 Orbiter", "agency": "ISRO",
     "info": "Polar orbiter, in lunar orbit since August 2019."},
    {"id": "capstone", "horizons": "-1176", "name": "CAPSTONE", "agency": "NASA / Advanced Space",
     "info": "CubeSat in the near-rectilinear halo orbit planned for Gateway."},
    {"id": "artemis-p1", "horizons": "-192", "name": "ARTEMIS P1 (THEMIS-B)", "agency": "NASA",
     "info": "Heliophysics probe in lunar orbit since 2011."},
    {"id": "artemis-p2", "horizons": "-193", "name": "ARTEMIS P2 (THEMIS-C)", "agency": "NASA",
     "info": "Heliophysics probe in lunar orbit since 2011."},
]


def _query(command: str, start: dt.datetime, stop: dt.datetime, step_min: int) -> str:
    params = {
        "format": "text", "COMMAND": f"'{command}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS", "CENTER": "'500@301'", "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF",
        "VEC_TABLE": "1", "VEC_CORR": "NONE", "OUT_UNITS": "KM-S", "CSV_FORMAT": "YES",
        "TIME_TYPE": "UT",
        "START_TIME": f"'{start:%Y-%m-%d %H:%M}'", "STOP_TIME": f"'{stop:%Y-%m-%d %H:%M}'",
        "STEP_SIZE": f"'{step_min}m'",
    }
    r = requests.get(API, params=params, headers={"User-Agent": kernels.USER_AGENT}, timeout=120)
    r.raise_for_status()
    return r.text


def _coverage_end(text: str):
    m = re.search(r'after A\.D\. (\d{4}-[A-Z]{3}-\d{2} \d{2}:\d{2})', text, re.I)
    return dt.datetime.strptime(m.group(1).title(), "%Y-%b-%d %H:%M") if m else None


def _parse(text: str):
    if "$$SOE" not in text:
        return None
    rows = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    jd, xyz = [], []
    for row in rows:
        p = [c.strip() for c in row.split(",")]
        jd.append(float(p[0]))
        xyz.append([float(p[2]), float(p[3]), float(p[4])])
    return np.array(jd), np.array(xyz)


def build(out_path=WEB_DATA_DIR / "spacecraft.json", days_before=2, days_after=12, step_min=5, now=None, verbose=True):
    kernels.furnish()
    now = (now or dt.datetime.utcnow()).replace(minute=0, second=0, microsecond=0)
    start, stop = now - dt.timedelta(days=days_before), now + dt.timedelta(days=days_after)
    out = []
    for craft in CRAFT:
        text = _query(craft["horizons"], start, stop, step_min)
        parsed = _parse(text)
        if parsed is None:
            end = _coverage_end(text)
            if end and end > start + dt.timedelta(hours=6):
                parsed = _parse(_query(craft["horizons"], start, end, step_min))
        if parsed is None:
            if verbose:
                print(f"{craft['id']:16s} no published trajectory for this window - skipped")
            continue
        jd, xyz = parsed
        t_ms = np.round((jd - 2440587.5) * 86400000.0)
        me = np.empty_like(xyz)
        for i, (t, v) in enumerate(zip(t_ms, xyz)):
            et = sp.utc2et(dt.datetime.utcfromtimestamp(t / 1000).strftime("%Y-%m-%dT%H:%M:%S"))
            me[i] = sp.mxv(sp.pxform("J2000", MOON_FRAME, et), v)
        r = np.linalg.norm(me, axis=1)
        out.append({
            **{k: craft[k] for k in ("id", "name", "agency", "info")},
            "horizons_id": craft["horizons"],
            "t0_ms": int(t_ms[0]), "step_ms": step_min * 60000, "n": len(t_ms),
            "xyz_km": [round(float(c), 1) for c in me.reshape(-1)],
        })
        if verbose:
            print(f"{craft['id']:16s} {len(t_ms):5d} samples  altitude {r.min() - 1737.4:8.0f} .. {r.max() - 1737.4:8.0f} km")
    doc = {
        "format": "lunarnav-spacecraft-1", "frame": "MOON_ME", "units": "km, Moon-centred",
        "source": "NASA/JPL Horizons System (https://ssd.jpl.nasa.gov/horizons/), rotated to the lunar Mean-Earth frame with SPICE",
        "generated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
        "window_utc": [start.strftime("%Y-%m-%dT%H:%MZ"), stop.strftime("%Y-%m-%dT%H:%MZ")],
        "spacecraft": out,
    }
    out_path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    return doc


def register(sub):
    p = sub.add_parser("build-spacecraft", help="fetch current lunar spacecraft trajectories from JPL Horizons")
    p.add_argument("--days-before", type=int, default=2)
    p.add_argument("--days-after", type=int, default=12)
    p.add_argument("--step-min", type=int, default=5)
    p.set_defaults(func=lambda a: build(days_before=a.days_before, days_after=a.days_after, step_min=a.step_min) and 0)
