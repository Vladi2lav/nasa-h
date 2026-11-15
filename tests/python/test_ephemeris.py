import json

import numpy as np
import pytest

from lunarnav import ephemeris as E
from lunarnav import validate as V
from lunarnav.constants import FIXTURE_DIR, MOON_RADIUS_KM, WEB_DATA_DIR

DAY = 86400.0


def test_time_conversion_and_leap_seconds():
    assert E.ms_to_et(E.iso_to_ms("2000-01-01T12:00:00Z")) == pytest.approx(64.184, abs=1e-3)
    assert E.ms_to_et(E.iso_to_ms("1972-01-01T00:00:00Z")) - \
        E.ms_to_et(E.iso_to_ms("1971-12-31T23:59:59Z")) == pytest.approx(2.0, abs=1e-6)
    assert E.ms_to_et(E.iso_to_ms("2017-01-01T00:00:00Z")) - \
        E.ms_to_et(E.iso_to_ms("2016-12-31T23:59:59Z")) == pytest.approx(2.0, abs=1e-6)
    assert E.et_to_iso(E.iso_to_et("2024-02-22T23:23:00Z")) == "2024-02-22T23:23:00.000Z"


def test_site_frame_is_orthonormal_and_right_handed():
    f = E.site_frame(-69.373, 32.319, 1234.0)
    m = np.vstack([f.east, f.north, f.up])
    assert np.allclose(m @ m.T, np.eye(3), atol=1e-14)
    assert np.allclose(np.cross(f.east, f.north), f.up, atol=1e-14)
    assert np.linalg.norm(f.pos) == pytest.approx(MOON_RADIUS_KM + 1.234)


def test_apollo11_landing_sun_elevation():
    et = E.iso_to_et("1969-07-20T20:17:40Z")
    sky = E.sky(0.67416, 23.47314, 0.0, et)
    assert float(sky["sun"]["el"]) == pytest.approx(10.8, abs=0.2)
    assert float(sky["sun"]["az"]) == pytest.approx(89.0, abs=1.5)
    assert float(sky["earth"]["el"]) > 55


def test_synodic_month():
    et0 = E.iso_to_et("2023-01-01T00:00:00Z")
    et = et0 + np.arange(0, 730 * DAY, 1800.0)
    el = E.sky(0.67416, 23.47314, 0.0, et)["sun"]["el"]
    i = np.nonzero((el[:-1] < 0) & (el[1:] >= 0))[0]
    t = et[i] + (et[i + 1] - et[i]) * (-el[i]) / (el[i + 1] - el[i])
    periods = np.diff(t) / DAY
    assert np.mean(periods) == pytest.approx(29.5306, abs=0.03)
    assert periods.min() > 29.2 and periods.max() < 29.9


def test_south_pole_earth_elevation_range():
    et0 = E.iso_to_et("2024-01-01T00:00:00Z")
    et = et0 + np.arange(0, 3 * 365 * DAY, 6 * 3600.0)
    el = E.topocentric(E.site_frame(-90.0, 0.0), E.earth_vector(et), 6378.137)["el"]
    assert -7.3 < el.min() < -5.5
    assert 5.5 < el.max() < 7.3


def test_sub_points_match_zenith():
    et = E.iso_to_et("2031-06-10T09:00:00Z")
    lat, lon = E.sub_point(E.sun_vector(et))
    assert float(E.sky(float(lat), float(lon), 0.0, et)["sun"]["el"]) > 89.99


def test_contract_mode_matches_exact_observer():
    et = E.iso_to_et("2040-05-05T05:05:05Z") + np.arange(5) * 7 * DAY
    a = E.sky(-89.45, -137.31, 2.0, et)
    b = E.sky(-89.45, -137.31, 2.0, et, exact=True)
    for body in ("sun", "earth"):
        sep = V._separation_deg(a[body]["az"], a[body]["el"], b[body]["az"], b[body]["el"])
        assert sep.max() < 1e-4


def test_station_elevation_geometric_vs_exact():
    et = E.iso_to_et("2025-03-01T00:00:00Z") + np.arange(0, DAY, 3 * 3600.0)
    mv = E.moon_vector_earth_fixed(et)
    for st in V.DSN_STATIONS.values():
        assert np.abs(E.station_elevation(st, mv) - E.station_elevation_exact(st, et)).max() < 5e-4


def test_earth_fixed_frame_selection():
    assert E.earth_fixed_frame(E.iso_to_et("1969-07-20T00:00:00Z")) == "ITRF93"
    assert E.earth_fixed_frame(E.iso_to_et("1950-01-01T00:00:00Z")) == "IAU_EARTH"


def test_web_export_matches_spice():
    index = json.loads((WEB_DATA_DIR / "ephem" / "index.json").read_text())
    assert index["format"] == "lunarnav-ephem-1" and index["fields"] == list(E.EPHEM_FIELDS)
    L, pad = index["chunk_len"], index["pad"]
    for chunk in (index["first_chunk"], 50, index["last_chunk"]):
        raw = np.fromfile(WEB_DATA_DIR / "ephem" / f"c{chunk}.bin", dtype="<f4").reshape(-1, 9)
        assert raw.shape[0] == L + 2 * pad
        rows = np.array([0, 1, L // 2, L + 2 * pad - 1])
        k = chunk * L - pad + rows
        ref = E.ephem_samples(index["t0_et"] + k * float(index["step_s"]))
        assert np.allclose(raw[rows, :3], ref[:, :3], rtol=1e-6)
        assert np.allclose(raw[rows, 3:6], ref[:, 3:6], rtol=1e-6)
        assert np.allclose(raw[rows, 6:], ref[:, 6:], atol=1e-6)
    start = E.iso_to_et(index["coverage_utc"][0] + "T00:00:00Z")
    end = E.iso_to_et(index["coverage_utc"][1] + "T00:00:00Z")
    assert index["t0_et"] <= start
    last_k = (index["last_chunk"] + 1) * L - 1
    assert index["t0_et"] + last_k * index["step_s"] >= end


def test_fixture_is_current():
    fx = json.loads((FIXTURE_DIR / "ephem_reference.json").read_text())
    e = fx["epochs"][5]
    et = E.ms_to_et(e["tMs"])
    assert et == pytest.approx(e["et"], abs=1e-6)
    assert np.allclose(E.sun_vector(et), e["sun"], rtol=1e-12)
    site = fx["sites"][2]
    el = E.sky(site["lat"], site["lon"], site["heightM"], et)["earth"]["el"]
    assert float(el) == pytest.approx(site["earth"]["el"][5], abs=1e-9)
