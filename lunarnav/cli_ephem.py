from __future__ import annotations

import json

from .constants import DEFAULT_OBSERVER_HEIGHT_M, WEB_DATA_DIR


def _cmd_kernels(args):
    from . import kernels
    for name in kernels.furnish(verbose=True):
        print(kernels.KERNEL_DIR / name)


def _cmd_build_ephem(args):
    from . import ephemeris
    index = ephemeris.build_web_ephemeris(args.out, verbose=True)
    n = index["last_chunk"] - index["first_chunk"] + 1
    print(f"wrote {args.out}: index.json + {n} chunks, coverage {index['coverage_utc']}")


def _cmd_fixture(args):
    from . import validate
    fx = validate.build_fixture()
    print(f"wrote {validate.FIXTURE_PATH}: {len(fx['sites'])} sites x {len(fx['epochs'])} epochs")


def _cmd_validate(args):
    from . import validate
    rows = validate.compare_with_horizons()
    print(validate.format_table(rows))
    parallax = validate.parallax_mode_difference()
    validate.write_report(rows, parallax)
    worst = max(r["d_sep"] for r in rows)
    print(f"\nmax angular difference vs Horizons: {worst:.6f} deg "
          f"(target < {validate.TARGET_TOLERANCE_DEG} deg)")
    print("contract mode vs exact observer (deg): "
          + ", ".join(f"{k} {v:.2e}" for k, v in parallax.items()))
    print(f"report: {validate.REPORT_PATH}")
    return 0 if worst < validate.TARGET_TOLERANCE_DEG else 1


def _cmd_sky(args):
    from . import ephemeris as E
    t_ms = E.iso_to_ms(args.time)
    et = E.ms_to_et(t_ms)
    res = E.sky(args.lat, args.lon, args.height, et, exact=args.exact)
    sun_sub = E.sub_point(E.sun_vector(et))
    earth_sub = E.sub_point(E.earth_vector(et))
    out = {
        "site": {"lat": args.lat, "lon": args.lon, "height_m": args.height},
        "utc": E.et_to_iso(et), "tMs": t_ms, "et": et,
        "mode": "exact" if args.exact else "contract",
        "sun": {k: float(v) for k, v in res["sun"].items()},
        "earth": {k: float(v) for k, v in res["earth"].items()},
        "sub_solar": {"lat": float(sun_sub[0]), "lon": float(sun_sub[1])},
        "sub_earth": {"lat": float(earth_sub[0]), "lon": float(earth_sub[1])},
    }
    if args.json:
        print(json.dumps(out, indent=2))
        return
    print(f"Site  lat {args.lat:+.5f} deg, lon {args.lon:+.5f} deg E, "
          f"height {args.height:g} m above R = 1737.4 km")
    print(f"Time  {out['utc']}  (et {et:.3f} s TDB past J2000)")
    for key, label in (("sun", "Sun"), ("earth", "Earth")):
        b = out[key]
        state = "above" if b["el"] > 0 else "below"
        print(f"{label:<6}az {b['az']:8.4f} deg  el {b['el']:+8.4f} deg ({state} the "
              f"astronomical horizon)  range {b['range_km']:,.0f} km  "
              f"angular radius {b['angular_radius_deg']:.4f} deg")
    print(f"Sub-solar point  lat {out['sub_solar']['lat']:+.4f}  lon {out['sub_solar']['lon']:+.4f}")
    print(f"Sub-Earth point  lat {out['sub_earth']['lat']:+.4f}  lon {out['sub_earth']['lon']:+.4f}")


def register(subparsers):
    p = subparsers.add_parser("kernels", help="download the NAIF SPICE kernels")
    p.set_defaults(func=_cmd_kernels)

    p = subparsers.add_parser("build-ephem", help="build web/data/ephem (index.json + chunks)")
    p.add_argument("--out", default=str(WEB_DATA_DIR / "ephem"), help="output directory")
    p.set_defaults(func=_cmd_build_ephem)

    p = subparsers.add_parser("build-ephem-fixture",
                              help="write tests/fixtures/ephem_reference.json")
    p.set_defaults(func=_cmd_fixture)

    p = subparsers.add_parser("validate-horizons",
                              help="compare Sun/Earth az/el with JPL Horizons; write the report")
    p.set_defaults(func=_cmd_validate)

    p = subparsers.add_parser("sky", help="Sun and Earth azimuth/elevation at a lunar site")
    p.add_argument("--lat", type=float, required=True, help="planetocentric latitude, deg")
    p.add_argument("--lon", type=float, required=True, help="east longitude, deg")
    p.add_argument("--height", type=float, default=DEFAULT_OBSERVER_HEIGHT_M,
                   help="observer height above the 1737.4 km sphere, m (default %(default)s)")
    p.add_argument("--time", required=True, help="ISO-8601 UTC, e.g. 2024-02-22T23:23:00Z")
    p.add_argument("--exact", action="store_true",
                   help="solve light time/aberration for the surface observer (SPICE spkcpo)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.set_defaults(func=_cmd_sky)
