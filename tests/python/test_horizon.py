import json
import math

import numpy as np
import pytest

from lunarnav import dem, horizon
from lunarnav.constants import FIXTURE_DIR, MOON_RADIUS_M, WEB_DATA_DIR

HAVE_WEB = (WEB_DATA_DIR / "dem" / "global.json").exists() and (WEB_DATA_DIR / "dem" / "south.json").exists()
HAVE_RAW = all(dem.local_path(k).exists() for k in ("ldem_128", "ldem_80s_20m_adj", "ldem_80n_20m"))
need_web = pytest.mark.skipif(not HAVE_WEB, reason="web/data/dem not built")
need_raw = pytest.mark.skipif(not HAVE_RAW, reason="LOLA source products not downloaded")


def _flat(projection="equirect"):
    if projection == "equirect":
        return dem.Raster(name="sphere", data=np.zeros((180, 360), np.int16), projection="equirect",
                          ppd=1.0, lat_top=90.0, lon_left=-180.0)
    n = 2001
    return dem.Raster(name="sphere", data=np.zeros((n, n), np.int16), projection="polar_stereo", pole="S",
                      m_per_px=500.0, x0_m=-(n - 1) / 2 * 500.0, y0_m=(n - 1) / 2 * 500.0)


@pytest.mark.parametrize("h", [2.0, 100.0, 1000.0, 5000.0])
@pytest.mark.parametrize("projection", ["equirect", "polar_stereo"])
def test_smooth_sphere_dip(h, projection):
    lat = 20.0 if projection == "equirect" else -88.0
    tier = horizon.Tier(_flat(projection), step_m=2.0)
    prof = horizon.compute_horizon(lat, 40.0, tiers=[tier], observer_height_m=h, az_step_deg=10.0,
                                   max_range_km=400.0)
    expected = -math.degrees(math.acos(MOON_RADIUS_M / (MOON_RADIUS_M + h)))
    assert expected == pytest.approx(horizon.sphere_dip_deg(h))
    assert np.allclose(prof.elev_deg, expected, atol=2e-3)
    assert prof.max_range_km < math.sqrt(2 * MOON_RADIUS_M * h) / 1e3 + 200.0


def test_pixel_latlon_round_trip():
    for r in (_flat("equirect"), _flat("polar_stereo")):
        lat = np.array([-89.5, -85.0, -80.1]) if r.projection == "polar_stereo" else np.array([-60.0, 0.3, 75.0])
        lon = np.array([-179.0, 12.5, 179.9])
        row, col = r.latlon_to_pixel(lat, lon)
        lat2, lon2 = r.pixel_to_latlon(row, col)
        assert np.allclose(lat2, lat) and np.allclose((lon2 - lon + 180) % 360 - 180, 0, atol=1e-9)


def test_polar_projection_hemisphere():
    r = _flat("polar_stereo")
    assert np.isnan(r.sample(88.0, 10.0)).all()
    assert np.isfinite(r.sample(-88.0, 10.0)).all()


@need_raw
def test_pds_label_scaling_and_geometry():
    g = dem.global_dem()
    assert g.scale == 0.5 and g.offset == 0.0 and g.ppd == 128
    assert g.lat_top == pytest.approx(90.0) and g.lon_left == pytest.approx(0.0)
    n = dem.polar_dem("N")
    assert n.pole == "N" and n.m_per_px == 20.0 and n.x0_m == pytest.approx(-303990.0)


@need_raw
@pytest.mark.parametrize("pole", ["S", "N"])
def test_polar_and_global_dem_agree(pole):
    fine, g = dem.polar_dem(pole), dem.global_dem()
    sign = -1 if pole == "S" else 1
    rng = np.random.default_rng(1)
    lat = sign * rng.uniform(80.5, 86.0, 400)
    lon = rng.uniform(-180, 180, 400)
    d = fine.sample(lat, lon) - g.sample(lat, lon)
    d = d[np.isfinite(d)]
    assert len(d) > 300
    assert abs(np.median(d)) < 15.0
    assert np.percentile(np.abs(d), 75) < 120.0


@need_raw
def test_shackleton_geometry():
    s = dem.polar_dem("S")
    rim = s.sample(-89.78, -155.7)[0]
    floor = s.sample(-89.67, 129.8)[0]
    assert 3000.0 < rim - floor < 5000.0


@need_raw
def test_shackleton_rim_horizon_is_low():
    prof = horizon.compute_horizon(-89.7755, -156.448, az_step_deg=1.0)
    assert prof.elev_deg.max() < 3.0
    assert prof.elev_deg.min() > -4.0
    assert "20 m/px" in prof.source


@need_raw
def test_shackleton_rim_near_field():
    near = horizon.compute_horizon(-89.78, -155.7, az_step_deg=2.0)
    far = horizon.compute_horizon(-89.78, -155.7, az_step_deg=2.0, min_range_km=1.0)
    assert near.elev_deg.min() > 1.0
    assert far.elev_deg.max() < 3.0 and far.elev_deg.min() > -4.0


@need_raw
def test_apollo15_hadley_delta_to_the_south():
    prof = horizon.compute_horizon(26.13239, 3.6333, az_step_deg=1.0)
    south = prof.elevation_at(np.arange(160.0, 201.0))
    west = prof.elevation_at(np.arange(250.0, 291.0))
    assert south.max() > 5.0
    assert south.mean() > west.mean() + 3.0


@need_raw
def test_observer_height_lowers_horizon():
    low = horizon.compute_horizon(-85.98, -0.26, az_step_deg=2.0, observer_height_m=2.0)
    high = horizon.compute_horizon(-85.98, -0.26, az_step_deg=2.0, observer_height_m=50.0)
    assert np.all(high.elev_deg <= low.elev_deg + 1e-9)
    assert (low.elev_deg - high.elev_deg).mean() > 0.0


@need_web
def test_web_and_highres_horizons_are_consistent():
    fx = json.loads((FIXTURE_DIR / "horizon_reference.json").read_text())
    for site in fx["sites"]:
        web = np.array(site["elev_deg"])
        high = np.array(site["highres"]["elev_deg"])
        stats = site["highres"]["web_minus_high"]
        if abs(site["lat"]) >= 75:
            assert stats["beyond_1km"]["rms_deg"] < 0.15, site["id"]
            assert stats["beyond_1km"]["max_abs_deg"] < 0.6, site["id"]
        else:
            assert stats["all"]["rms_deg"] < 5.0, site["id"]
            assert np.corrcoef(web, high)[0, 1] > 0.9, site["id"]
            assert stats["all"]["mean_deg"] < 0.5, site["id"]


@need_web
def test_web_grid_contract():
    for key, proj in (("global", "equirect"), ("south", "polar_stereo"), ("north", "polar_stereo")):
        hdr = json.loads((WEB_DATA_DIR / "dem" / f"{key}.json").read_text())
        assert hdr["format"] == "lunarnav-dem-1" and hdr["projection"] == proj
        assert hdr["radius_m"] == MOON_RADIUS_M and hdr["nodata"] == -32768
        if proj == "polar_stereo":
            assert hdr["width"] * hdr["m_per_px"] / 2 >= 2 * MOON_RADIUS_M * math.tan(math.radians(5))
            assert hdr["x0_m"] == -hdr["y0_m"]
        else:
            assert (hdr["width"], hdr["height"], hdr["ppd"]) == (2880, 1440, 8)
    g = dem.Raster.from_header(WEB_DATA_DIR / "dem" / "global.json")
    s = dem.Raster.from_header(WEB_DATA_DIR / "dem" / "south.json")
    lat = np.full(36, -79.0)
    lon = np.arange(-180.0, 180.0, 10.0)
    assert np.nanmedian(np.abs(g.sample(lat, lon) - s.sample(lat, lon))) < 150.0


@need_web
def test_web_python_matches_fixture():
    fx = json.loads((FIXTURE_DIR / "horizon_reference.json").read_text())
    site = fx["sites"][0]
    prof = horizon.compute_horizon(site["lat"], site["lon"], resolution="web", az_step_deg=fx["az_step_deg"],
                                   max_range_km=fx["max_range_km"])
    assert np.abs(prof.elev_deg - np.array(site["elev_deg"])).max() < 1e-3
