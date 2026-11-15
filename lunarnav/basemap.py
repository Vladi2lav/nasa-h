from __future__ import annotations

import json
import math

import numpy as np
from PIL import Image

from . import dem as demmod
from .constants import MOON_RADIUS_M, WEB_DATA_DIR

MAPS_DIR = WEB_DATA_DIR / "maps"
POLAR_MAP_PX = 2048
SUN_AZIMUTH_DEG = 315.0
SUN_ALTITUDE_DEG = 35.0

_HYPSO = [
    (-9000, (26, 40, 92)), (-6000, (38, 82, 150)), (-3500, (60, 140, 175)), (-1500, (110, 180, 160)),
    (0, (170, 200, 140)), (1500, (215, 205, 135)), (3500, (205, 160, 100)), (6000, (170, 110, 80)),
    (8500, (220, 205, 200)), (11000, (255, 255, 255)),
]
_INFERNO = [(0.0, (0, 0, 4)), (0.2, (66, 10, 104)), (0.4, (147, 38, 103)), (0.6, (221, 81, 58)),
            (0.8, (252, 165, 10)), (1.0, (252, 255, 164))]
_VIRIDIS = [(0.0, (68, 1, 84)), (0.2, (65, 68, 135)), (0.4, (42, 120, 142)), (0.6, (34, 168, 132)),
            (0.8, (122, 209, 81)), (1.0, (253, 231, 37))]
_SHADOW_RGB = (20, 24, 40)


def _ramp(values: np.ndarray, stops) -> np.ndarray:
    xs = np.array([s[0] for s in stops], dtype=np.float64)
    cols = np.array([s[1] for s in stops], dtype=np.float64)
    v = np.clip(values, xs[0], xs[-1])
    out = np.stack([np.interp(v, xs, cols[:, k]) for k in range(3)], axis=-1)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _hillshade(h: np.ndarray, dx: np.ndarray | float, dy: float) -> np.ndarray:
    gy, gx = np.gradient(h)
    dzdx = gx / dx
    dzdy = -gy / dy
    az = math.radians(SUN_AZIMUTH_DEG)
    alt = math.radians(SUN_ALTITUDE_DEG)
    lx, ly, lz = math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt)
    norm = np.sqrt(dzdx ** 2 + dzdy ** 2 + 1.0)
    return np.clip((-dzdx * lx - dzdy * ly + lz) / norm, 0.0, 1.0)


def _shade_rgb(h: np.ndarray, shade: np.ndarray) -> np.ndarray:
    tint = _ramp(h, _HYPSO).astype(np.float64)
    return np.clip(tint * (0.25 + 0.95 * shade[..., None]), 0, 255).astype(np.uint8)


def _resize(a: np.ndarray, w: int, h: int, method=Image.Resampling.BOX) -> np.ndarray:
    return np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize((w, h), method),
                      dtype=np.float64)


def build_global_color() -> dict:
    import tifffile

    src = demmod.fetch("svs_lroc_color_4k")
    rgb16 = tifffile.imread(src)
    rgb = np.clip(np.rint(rgb16.astype(np.float64) / 257.0), 0, 255).astype(np.uint8)
    h, w = rgb.shape[:2]
    lum = rgb.astype(np.float64).mean(axis=2)
    web = demmod.Raster.from_header(WEB_DATA_DIR / "dem" / "global.json")
    elev = _resize(np.asarray(web.data, np.float64), w // 8, h // 8)
    lum_s = _resize(lum, w // 8, h // 8)
    band = slice(h // 8 // 6, h // 8 * 5 // 6)
    corr = lambda a, b: float(np.corrcoef(a[band].ravel(), b[band].ravel())[0, 1])
    c0 = corr(lum_s, elev)
    c180 = corr(np.roll(lum_s, w // 16, axis=1), elev)
    if not c0 > c180 + 0.1:
        raise RuntimeError(f"unexpected longitude origin of the SVS colour map (r0={c0:.2f}, r180={c180:.2f})")
    if (w, h) != (4096, 2048):
        rgb = np.asarray(Image.fromarray(rgb).resize((4096, 2048), Image.Resampling.LANCZOS))
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(MAPS_DIR / "global_color.jpg", quality=88, optimize=True)
    p = demmod.PRODUCTS["svs_lroc_color_4k"]
    return {"file": "global_color.jpg", "projection": "equirect", "width": 4096, "height": 2048,
            "extent_deg": {"lon": [-180, 180], "lat": [-90, 90]},
            "content": "LROC WAC colour (albedo) mosaic, sRGB",
            "credit": p.citation, "source_url": p.files[0][0], "landing_page": p.landing_page,
            "lon_origin_check": {"corr_brightness_height_as_is": round(c0, 3),
                                 "corr_if_rolled_180deg": round(c180, 3)}}


def build_global_shade() -> dict:
    g = demmod.global_dem()
    coarse = demmod.block_mean(g, 4, "ldem_128_x4")
    h32 = np.asarray(coarse.data, dtype=np.float32) * np.float32(coarse.scale)
    shift = int(round(((-180.0 - coarse.lon_left) % 360.0) * coarse.ppd))
    h32 = np.roll(h32, -shift, axis=1)
    W, H = 4096, 2048
    hm = _resize(h32, W, H)
    lat = 90.0 - (np.arange(H) + 0.5) * 180.0 / H
    dy = MOON_RADIUS_M * math.pi / H
    dx = np.maximum(MOON_RADIUS_M * np.cos(np.radians(lat)) * 2 * math.pi / W, dy * 0.02)[:, None]
    rgb = _shade_rgb(hm, _hillshade(hm, dx, dy))
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(MAPS_DIR / "global_shade.jpg", quality=88, optimize=True)
    return {"file": "global_shade.jpg", "projection": "equirect", "width": W, "height": H,
            "extent_deg": {"lon": [-180, 180], "lat": [-90, 90]},
            "content": f"LOLA colour-shaded relief (hypsometric tint x hillshade, light from azimuth "
                       f"{SUN_AZIMUTH_DEG:.0f} deg map-north-west, altitude {SUN_ALTITUDE_DEG:.0f} deg)",
            "legend": _hypso_legend(),
            "credit": demmod.PRODUCTS["ldem_128"].citation + " Rendered by lunarnav."}


def _hypso_legend() -> dict:
    return {"quantity": "height above the 1737.4 km reference sphere", "unit": "m",
            "stops": [[v, "#%02x%02x%02x" % c] for v, c in _HYPSO]}


def _polar_extent(web_hdr: dict) -> dict:
    half = web_hdr["width"] * web_hdr["m_per_px"] / 2.0
    return {"x_m": [-half, half], "y_m": [-half, half]}


def build_polar_shade(pole: str) -> dict:
    key = "south" if pole == "S" else "north"
    hdr = json.loads((WEB_DATA_DIR / "dem" / f"{key}.json").read_text())
    web = demmod.Raster.from_header(WEB_DATA_DIR / "dem" / f"{key}.json")
    h = np.asarray(web.data, dtype=np.float64)
    shade = _hillshade(h, web.m_per_px, web.m_per_px)
    rgb = _shade_rgb(h, shade)
    img = Image.fromarray(rgb).resize((POLAR_MAP_PX, POLAR_MAP_PX), Image.Resampling.LANCZOS)
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    img.save(MAPS_DIR / f"{key}_shade.jpg", quality=88, optimize=True)
    return {"file": f"{key}_shade.jpg", "projection": "polar_stereo", "pole": pole,
            "width": POLAR_MAP_PX, "height": POLAR_MAP_PX, "m_per_px": hdr["width"] * hdr["m_per_px"] / POLAR_MAP_PX,
            "extent": _polar_extent(hdr), "same_extent_as": f"dem/{key}.json",
            "content": "LOLA colour-shaded relief (hypsometric tint x hillshade)",
            "legend": _hypso_legend(), "credit": hdr["source"] + ". Rendered by lunarnav."}


def build_polar_illumination(kind: str) -> dict:
    key = f"avgvisib_65s_240m_{kind}"
    src = demmod.open_product(key)
    hdr = json.loads((WEB_DATA_DIR / "dem" / "south.json").read_text())
    n = hdr["width"]
    j0 = int(round((hdr["x0_m"] - src.x0_m) / src.m_per_px))
    i0 = int(round((src.y0_m - hdr["y0_m"]) / src.m_per_px))
    if abs(src.m_per_px - hdr["m_per_px"]) > 1e-9 or abs(src.x0_m + j0 * src.m_per_px - hdr["x0_m"]) > 1e-6:
        raise RuntimeError(f"{key} is not on the web polar pixel lattice")
    frac = np.asarray(src.data[i0:i0 + n, j0:j0 + n], dtype=np.float64) * src.scale + src.offset
    never = _resize((frac <= 0).astype(np.float64), POLAR_MAP_PX, POLAR_MAP_PX) > 0.5
    frac = np.clip(_resize(frac, POLAR_MAP_PX, POLAR_MAP_PX), 0.0, 1.0)
    stops = _INFERNO if kind == "sun" else _VIRIDIS
    idx = np.clip(np.rint(frac * 254) + 1, 1, 255).astype(np.uint8)
    idx[never] = 0
    palette = [_SHADOW_RGB] + [tuple(int(c) for c in _ramp(np.array([(k - 1) / 254.0]), stops)[0])
                               for k in range(1, 256)]
    img = Image.fromarray(idx, mode="P")
    img.putpalette([c for rgb in palette for c in rgb])
    name = f"south_avg_{kind}.png"
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    img.save(MAPS_DIR / name, optimize=True)
    p = demmod.PRODUCTS[key]
    body = "Sun" if kind == "sun" else "Earth"
    return {"file": name, "projection": "polar_stereo", "pole": "S", "width": POLAR_MAP_PX,
            "height": POLAR_MAP_PX, "m_per_px": n * hdr["m_per_px"] / POLAR_MAP_PX,
            "extent": _polar_extent(hdr), "same_extent_as": "dem/south.json",
            "content": f"average {body} visibility: fraction of hourly time steps over 18.6 years in which "
                       f"any part of the {body} disc is above the local horizon (LOLA LDEM_65S_240M "
                       f"topography, surface observer)",
            "legend": {"quantity": f"fraction of time {body} visible", "unit": "1",
                       "encoding": "palette index k: 0 = never visible (permanent shadow); "
                                   "k = 1..255 -> fraction (k - 1) / 254",
                       "never_visible_color": "#%02x%02x%02x" % _SHADOW_RGB,
                       "stops": [[v, "#%02x%02x%02x" % c] for v, c in stops]},
            "credit": p.citation, "source_url": p.files[0][0]}


def build_maps() -> dict:
    maps = {
        "global_color": build_global_color(),
        "global_shade": build_global_shade(),
        "south_shade": build_polar_shade("S"),
        "north_shade": build_polar_shade("N"),
        "south_avg_sun": build_polar_illumination("sun"),
        "south_avg_earth": build_polar_illumination("earth"),
    }
    doc = {"format": "lunarnav-maps-1",
           "projections": {
               "equirect": "lon -180..180 left to right, lat +90 at top, pixel-registered",
               "polar_stereo": "spherical polar stereographic, true scale at the pole, R = 1737400 m; "
                               "r = 2R tan((90-|lat|)/2); south: x = r sin(lon), y = r cos(lon); "
                               "north: x = r sin(lon), y = -r cos(lon); image top = +y, left = -x"},
           "maps": maps}
    (MAPS_DIR / "maps.json").write_text(json.dumps(doc, indent=1))
    return doc
