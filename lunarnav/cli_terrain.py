from __future__ import annotations

import json
import sys
import time

import numpy as np

from .constants import DEFAULT_OBSERVER_HEIGHT_M, FIXTURE_DIR, WEB_DATA_DIR

HORIZON_DIR = WEB_DATA_DIR / "horizons"

FIXTURE_SITES = (
    ("shackleton-rim", -89.78, -155.7, "south-pole rim, rays cross the pole"),
    ("malapert-massif", -85.98, -0.26, "high massif, far-reaching horizon"),
    ("boundary-80s", -80.05, 100.0, "next to the 80 deg S edge of the 20 m polar data"),
    ("apollo-15", 26.13239, 3.6333, "Hadley-Apennine, mountains to the south"),
    ("farside-midlat", -20.4, 129.1, "Tsiolkovskiy, far-side mid latitude"),
    ("antimeridian", 5.0, 179.9, "rays cross the +-180 deg meridian"),
    ("north-pole-region", 88.6, 33.0, "Peary crater, north polar grid"),
    ("polar-grid-corner", -77.0, 45.0, "polar grid corner / global grid hand-over"),
)


def _cmd_build_dem(args):
    from . import dem

    todo = args.only or ["global", "south", "north"]
    for key in todo:
        t0 = time.time()
        hdr = dem.build_web_global() if key == "global" else dem.build_web_polar("S" if key == "south" else "N")
        size = (WEB_DATA_DIR / "dem" / hdr["file"]).stat().st_size
        print(f"dem/{key}: {hdr['width']}x{hdr['height']}, {size / 1e6:.2f} MB, "
              f"{hdr['min_m']}..{hdr['max_m']} m, {time.time() - t0:.0f} s")
    return 0


def _load_sites():
    path = WEB_DATA_DIR / "sites.json"
    return json.loads(path.read_text(encoding="utf-8"))["sites"]


def _cmd_build_horizons(args):
    from . import horizon

    sites = _load_sites()
    if args.site:
        wanted = set(args.site)
        sites = [s for s in sites if s["id"] in wanted]
        missing = wanted - {s["id"] for s in sites}
        if missing:
            print(f"unknown site id(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 2
    HORIZON_DIR.mkdir(parents=True, exist_ok=True)
    for s in sites:
        prof = horizon.compute_horizon(s["lat"], s["lon"], az_step_deg=args.az_step,
                                       observer_height_m=args.observer_height,
                                       max_range_km=args.max_range_km)
        rec = prof.to_json(s["id"])
        (HORIZON_DIR / f"{s['id']}.json").write_text(json.dumps(rec, separators=(",", ":")))
        e = prof.elev_deg
        print(f"{s['id']:34s} h={prof.terrain_height_m:8.1f} m  horizon {e.min():6.2f}..{e.max():6.2f} deg"
              f"  range {prof.max_range_km:5.1f} km  {prof.compute_s:5.1f} s  [{prof.source}]")
    return 0


def _cmd_horizon(args):
    from . import horizon

    prof = horizon.compute_horizon(args.lat, args.lon, observer_height_m=args.observer_height,
                                   az_step_deg=args.az_step, max_range_km=args.max_range_km,
                                   resolution="web" if args.web else "high")
    if args.json:
        print(json.dumps(prof.to_json(None), indent=None, separators=(",", ":")))
        return 0
    print(f"site lat {prof.lat:.5f}  lon {prof.lon:.5f}  terrain {prof.terrain_height_m:.1f} m  "
          f"observer +{prof.observer_height_m:g} m")
    print(f"source: {prof.source}")
    print(f"rays reached at most {prof.max_range_km:.1f} km; computed in {prof.compute_s:.2f} s")
    print(" az(deg)  horizon(deg)")
    every = max(1, int(round(args.print_step / prof.az_step_deg)))
    for i in range(0, len(prof.elev_deg), every):
        print(f"  {i * prof.az_step_deg:6.1f}  {prof.elev_deg[i]:7.2f}")
    return 0


def _cmd_build_maps(args):
    from . import basemap

    doc = basemap.build_maps()
    for key, m in doc["maps"].items():
        size = (basemap.MAPS_DIR / m["file"]).stat().st_size
        print(f"maps/{m['file']}: {m['width']}x{m['height']}, {size / 1e6:.2f} MB")
    return 0


def _cmd_build_fixture(args):
    from . import horizon

    out = {"format": "lunarnav-horizon-fixture-1",
           "description": "Python horizons on the WEB grids (web/data/dem), az step 1 deg, observer 2 m, "
                          "max range 300 km; reference for tests/js/terrain.test.js",
           "observer_height_m": DEFAULT_OBSERVER_HEIGHT_M, "az_step_deg": 1.0, "max_range_km": 300.0,
           "sites": []}
    for sid, lat, lon, note in FIXTURE_SITES:
        web = horizon.compute_horizon(lat, lon, resolution="web", az_step_deg=1.0, max_range_km=300.0)
        high = horizon.compute_horizon(lat, lon, resolution="high", az_step_deg=1.0, max_range_km=400.0)
        cmp = {}
        for label, min_km in (("all", 0.0), ("beyond_1km", 1.0)):
            w = horizon.compute_horizon(lat, lon, resolution="web", az_step_deg=1.0, max_range_km=300.0,
                                        min_range_km=min_km)
            h = horizon.compute_horizon(lat, lon, resolution="high", az_step_deg=1.0, max_range_km=400.0,
                                        min_range_km=min_km)
            d = w.elev_deg - h.elev_deg
            cmp[label] = {"rms_deg": round(float(np.sqrt(np.mean(d ** 2))), 3),
                          "max_abs_deg": round(float(np.abs(d).max()), 3),
                          "mean_deg": round(float(d.mean()), 3)}
        out["sites"].append({
            "id": sid, "lat": lat, "lon": lon, "note": note,
            "terrain_height_m": round(web.terrain_height_m, 3),
            "elev_deg": [round(float(v), 5) for v in web.elev_deg],
            "source": web.source,
            "highres": {"terrain_height_m": round(high.terrain_height_m, 2),
                        "elev_deg": [round(float(v), 3) for v in high.elev_deg], "source": high.source,
                        "web_minus_high": cmp}})
        print(f"{sid:20s} web-high RMS {cmp['all']['rms_deg']:.3f} deg (max {cmp['all']['max_abs_deg']:.3f}); "
              f"terrain beyond 1 km: RMS {cmp['beyond_1km']['rms_deg']:.3f} (max {cmp['beyond_1km']['max_abs_deg']:.3f})")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    (FIXTURE_DIR / "horizon_reference.json").write_text(json.dumps(out, indent=None))
    return 0


def register(subparsers):
    p = subparsers.add_parser("build-dem", help="download LOLA DEMs and write web/data/dem/*")
    p.add_argument("--only", nargs="+", choices=["global", "south", "north"], help="grids to (re)build")
    p.set_defaults(func=_cmd_build_dem)

    def horizon_opts(q, default_range):
        q.add_argument("--az-step", type=float, default=0.5, help="azimuth step, deg (default 0.5)")
        q.add_argument("--observer-height", type=float, default=DEFAULT_OBSERVER_HEIGHT_M,
                       help="observer height above the terrain, m (default 2)")
        q.add_argument("--max-range-km", type=float, default=default_range,
                       help=f"hard cap of the ray length, km (default {default_range:g})")

    p = subparsers.add_parser("build-horizons", help="precompute horizon profiles of catalog sites")
    p.add_argument("--site", nargs="+", metavar="ID", help="only these site ids")
    horizon_opts(p, 400.0)
    p.set_defaults(func=_cmd_build_horizons)

    p = subparsers.add_parser("horizon", help="horizon profile of any point")
    p.add_argument("--lat", type=float, required=True, help="planetocentric latitude, deg")
    p.add_argument("--lon", type=float, required=True, help="east longitude, deg")
    p.add_argument("--web", action="store_true", help="use the web-resolution grids (as the browser does)")
    p.add_argument("--json", action="store_true", help="print a lunarnav-horizon-1 JSON record")
    p.add_argument("--print-step", type=float, default=10.0, help="azimuth spacing of the table, deg")
    horizon_opts(p, 400.0)
    p.set_defaults(func=_cmd_horizon)

    p = subparsers.add_parser("build-maps", help="write basemap textures web/data/maps/*")
    p.set_defaults(func=_cmd_build_maps)

    p = subparsers.add_parser("build-terrain-fixture",
                              help="write tests/fixtures/horizon_reference.json (needs dem + raw DEMs)")
    p.set_defaults(func=_cmd_build_fixture)
