from __future__ import annotations

import gzip
import json
import math
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import requests

from .constants import MOON_RADIUS_M, RAW_DIR

LOLA_DIR = RAW_DIR / "lola"
DERIVED_DIR = LOLA_DIR / "derived"
USER_AGENT = "lunarnav-data-pipeline/1.0 (+https://github.com/)"

NODATA_I16 = -32768
PROJ_EQUIRECT = "equirect"
PROJ_POLAR = "polar_stereo"

_PDS_GDR = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx"


@dataclass(frozen=True)
class Product:

    key: str
    title: str
    files: tuple
    resolution_m: float
    citation: str
    landing_page: str
    size_bytes: int = 0


_LOLA_GDR_CITATION = (
    "Smith, D.E. et al. (2017), LRO LOLA Gridded Data Records, LRO-L-LOLA-4-GDR-V1.0, "
    "NASA Planetary Data System; Smith, D.E. et al. (2010), The Lunar Orbiter Laser "
    "Altimeter investigation on the Lunar Reconnaissance Orbiter mission, Space Sci. Rev. 150, 209-241."
)
_BARKER_CITATION = (
    "Barker, M.K. et al. (2021), Improved LOLA elevation maps for south pole landing "
    "sites: error estimates and their impact on illumination conditions, Planet. Space "
    "Sci. 203, 105119. Data: NASA GSFC PGDA product 90."
)
_MAZARICO_CITATION = (
    "Mazarico, E. et al. (2011), Illumination conditions of the lunar polar regions using "
    "LOLA topography, Icarus 211, 1066-1081. Data: LOLA GDR extras/illumination, release 2016 (PDS)."
)
_SVS_CITATION = (
    "NASA's Scientific Visualization Studio, CGI Moon Kit (2019, colour map updated 2025), "
    "Ernie Wright; colour from LRO LROC WAC mosaics (Arizona State University). Public domain."
)


def _pds_img(key, path, size, res, title, citation=_LOLA_GDR_CITATION):
    base = f"{_PDS_GDR}/{path}"
    name = path.rsplit("/", 1)[1]
    return Product(
        key=key, title=title,
        files=((base, name), (base[:-4] + ".lbl", name[:-4] + ".lbl")),
        resolution_m=res, citation=citation,
        landing_page=f"{_PDS_GDR}/{path.rsplit('/', 2)[0]}/", size_bytes=size)


PRODUCTS = {
    p.key: p
    for p in (
        _pds_img("ldem_128", "data/lola_gdr/cylindrical/img/ldem_128.img", 2_123_366_400, 236.9,
                 "LOLA LDEM_128 global simple-cylindrical DEM, 128 px/deg"),
        _pds_img("ldem_80n_20m", "data/lola_gdr/polar/img/ldem_80n_20m.img", 1_848_320_000, 20.0,
                 "LOLA LDEM_80N_20M north polar stereographic DEM, 80-90 N, 20 m/px"),
        Product(
            key="ldem_80s_20m_adj",
            title="LOLA LDEM_80S_20MPP_ADJ south polar stereographic DEM, 80-90 S, 20 m/px "
                  "(crossover-adjusted, Barker et al. 2021)",
            files=(("https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF",
                    "LDEM_80S_20MPP_ADJ.TIF"),),
            resolution_m=20.0, citation=_BARKER_CITATION,
            landing_page="https://pgda.gsfc.nasa.gov/products/90", size_bytes=2_800_000_000),
        _pds_img("avgvisib_65s_240m_sun", "extras/illumination/img/avgvisib_65s_240m_201608.img",
                 82_432_800, 240.0,
                 "LOLA average solar illumination, south pole 65-90 S, 240 m/px (18.6-yr average)",
                 _MAZARICO_CITATION),
        _pds_img("avgvisib_65s_240m_earth", "extras/illumination/img/avgvisib_65s_240m_201608_earth.img",
                 82_432_800, 240.0,
                 "LOLA average Earth visibility, south pole 65-90 S, 240 m/px (18.6-yr average)",
                 _MAZARICO_CITATION),
        Product(
            key="svs_lroc_color_4k",
            title="NASA SVS CGI Moon Kit LROC colour map (2025), 4096 x 2048, 16-bit sRGB",
            files=(("https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif",
                    "lroc_color_16bit_srgb_4k.tif"),),
            resolution_m=2665.0, citation=_SVS_CITATION,
            landing_page="https://svs.gsfc.nasa.gov/4720", size_bytes=61_891_324),
    )
}


def _fmt_mb(n):
    return f"{n / 1e6:,.1f} MB"


def _fetch_range(url: str, part: Path, first: int, last: int, chunk: int = 1 << 20) -> None:
    want = last - first + 1
    for attempt in range(10):
        have = part.stat().st_size if part.exists() else 0
        if have >= want:
            return
        headers = {"User-Agent": USER_AGENT, "Range": f"bytes={first + have}-{last}"}
        try:
            with requests.get(url, headers=headers, stream=True, timeout=120) as res:
                if res.status_code != 206:
                    raise IOError(f"server does not honour byte ranges for {url}")
                with open(part, "ab") as fh:
                    for block in res.iter_content(chunk):
                        fh.write(block)
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError):
            time.sleep(min(30, 2 ** attempt))
    if part.stat().st_size < want:
        raise IOError(f"could not download {url} bytes {first}-{last}")


def download_file(url: str, dest: Path, *, quiet: bool = False, connections: int = 6,
                  segment_min_bytes: int = 64 << 20) -> Path:
    dest = Path(dest)
    if dest.exists():
        if not quiet:
            print(f"  present  {dest.name} ({_fmt_mb(dest.stat().st_size)})", file=sys.stderr)
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    head = requests.head(url, headers={"User-Agent": USER_AGENT}, allow_redirects=True, timeout=60)
    head.raise_for_status()
    total = int(head.headers.get("Content-Length", 0))
    if total <= 0:
        raise IOError(f"{url}: server did not report a Content-Length")
    with _exclusive_lock(dest.with_name(dest.name + ".lock")):
        return _download_segments(url, dest, total, quiet, connections, segment_min_bytes)


class _exclusive_lock:

    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        self.fh = open(self.path, "a+b")
        try:
            if sys.platform == "win32":
                import msvcrt
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            raise RuntimeError(f"{self.path.name[:-5]} is being downloaded by another process")
        return self

    def __exit__(self, *exc):
        self.fh.close()
        self.path.unlink(missing_ok=True)


def _download_segments(url, dest, total, quiet, connections, segment_min_bytes):
    from concurrent.futures import ThreadPoolExecutor

    if dest.exists() and dest.stat().st_size == total:
        return dest
    n = max(1, min(connections, total // segment_min_bytes))
    bounds = [(k * total // n, (k + 1) * total // n - 1) for k in range(n)]
    parts = [dest.with_name(f"{dest.name}.part{k + 1}-{n}") for k in range(n)]
    size_now = lambda: sum(p.stat().st_size for p in parts if p.exists())
    if not quiet:
        print(f"  fetch    {dest.name} ({_fmt_mb(total)}, {n} connection(s)) <- {url}", file=sys.stderr)
    t0, start = time.monotonic(), size_now()
    with ThreadPoolExecutor(n) as pool:
        futures = [pool.submit(_fetch_range, url, p, a, b) for p, (a, b) in zip(parts, bounds)]
        while not all(f.done() for f in futures):
            time.sleep(2.0)
            if not quiet:
                done = size_now()
                speed = (done - start) / max(time.monotonic() - t0, 1e-6)
                print(f"  {100 * done / total:5.1f}% {dest.name}  {_fmt_mb(done)} / {_fmt_mb(total)}"
                      f"  {speed / 1e6:.1f} MB/s", file=sys.stderr, flush=True)
        for f in futures:
            f.result()
    tmp = dest.with_name(dest.name + ".joining")
    with open(tmp, "wb") as out:
        for p in parts:
            with open(p, "rb") as fh:
                while block := fh.read(64 << 20):
                    out.write(block)
    if tmp.stat().st_size != total:
        raise IOError(f"incomplete download of {url}: {tmp.stat().st_size} of {total} bytes")
    tmp.replace(dest)
    for p in parts:
        p.unlink()
    if not quiet:
        print(f"  done     {dest.name} ({_fmt_mb(total)})", file=sys.stderr)
    return dest


def fetch(key: str, *, quiet: bool = False) -> Path:
    product = PRODUCTS[key]
    paths = [download_file(url, LOLA_DIR / name, quiet=quiet) for url, name in product.files]
    return paths[0]


def local_path(key: str) -> Path:
    return LOLA_DIR / PRODUCTS[key].files[0][1]


def parse_pds3_label(text: str) -> dict:
    out: dict = {}
    stack: list = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = re.sub(r"/\*.*?\*/", "", lines[i]).strip()
        i += 1
        if not line or "=" not in line:
            if line == "END":
                break
            continue
        key, val = (s.strip() for s in line.split("=", 1))
        while (val.count('"') % 2 == 1 or (val.startswith("{") and not val.endswith("}"))) and i < len(lines):
            val += " " + lines[i].strip()
            i += 1
        if key == "OBJECT":
            stack.append(val)
            continue
        if key == "END_OBJECT":
            if stack:
                stack.pop()
            continue
        val = val.strip().strip('"').strip()
        num = re.fullmatch(r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\.?\s*(<[^>]*>)?", val)
        if num:
            s = num.group(1)
            val = float(s) if any(c in s for c in ".eE") or line.split("=", 1)[1].strip().rstrip().endswith(".") else int(s)
        out["/".join(stack + [key])] = val
    return out


@dataclass
class Raster:

    name: str
    data: np.ndarray
    projection: str
    scale: float = 1.0
    offset: float = 0.0
    nodata: int | None = None
    ppd: float = 0.0
    lat_top: float = 90.0
    lon_left: float = -180.0
    pole: str | None = None
    x0_m: float = 0.0
    y0_m: float = 0.0
    m_per_px: float = 0.0
    radius_m: float = MOON_RADIUS_M
    source: str = ""
    meta: dict = field(default_factory=dict)


    @property
    def height(self) -> int:
        return self.data.shape[0]

    @property
    def width(self) -> int:
        return self.data.shape[1]

    @property
    def wraps_longitude(self) -> bool:
        return self.projection == PROJ_EQUIRECT and abs(self.width / self.ppd - 360.0) < 1e-9

    @property
    def resolution_m(self) -> float:
        if self.projection == PROJ_EQUIRECT:
            return self.radius_m * math.pi / 180.0 / self.ppd
        return self.m_per_px


    def latlon_to_xy(self, lat, lon):
        lat = np.asarray(lat, dtype=np.float64)
        lon = np.radians(np.asarray(lon, dtype=np.float64))
        sign = 1.0 if self.pole == "S" else -1.0
        colat = np.radians(90.0 + sign * lat)
        r = 2.0 * self.radius_m * np.tan(colat / 2.0)
        return r * np.sin(lon), sign * r * np.cos(lon)

    def xy_to_latlon(self, x, y):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        sign = 1.0 if self.pole == "S" else -1.0
        r = np.hypot(x, y)
        colat = 2.0 * np.degrees(np.arctan(r / (2.0 * self.radius_m)))
        lat = (colat - 90.0) if self.pole == "S" else (90.0 - colat)
        lon = np.degrees(np.arctan2(x, sign * y))
        return lat, lon

    def latlon_to_pixel(self, lat, lon):
        if self.projection == PROJ_EQUIRECT:
            lat = np.asarray(lat, dtype=np.float64)
            lon = np.asarray(lon, dtype=np.float64)
            row = (self.lat_top - lat) * self.ppd - 0.5
            col = np.mod(lon - self.lon_left, 360.0) * self.ppd - 0.5
            return row, col
        x, y = self.latlon_to_xy(lat, lon)
        return (self.y0_m - y) / self.m_per_px, (x - self.x0_m) / self.m_per_px

    def pixel_to_latlon(self, row, col):
        row = np.asarray(row, dtype=np.float64)
        col = np.asarray(col, dtype=np.float64)
        if self.projection == PROJ_EQUIRECT:
            lat = self.lat_top - (row + 0.5) / self.ppd
            lon = self.lon_left + (col + 0.5) / self.ppd
            return lat, (lon + 180.0) % 360.0 - 180.0
        return self.xy_to_latlon(self.x0_m + col * self.m_per_px, self.y0_m - row * self.m_per_px)

    def covers(self, lat, lon, margin_px: float = 1.0):
        row, col = self.latlon_to_pixel(lat, lon)
        ok = (row >= 0) & (row <= self.height - 1)
        if not self.wraps_longitude:
            ok &= (col >= 0) & (col <= self.width - 1)
        if self.projection == PROJ_POLAR:
            ok &= (row >= margin_px - 1) & (row <= self.height - margin_px) & \
                  (col >= margin_px - 1) & (col <= self.width - margin_px)
        return ok


    def sample(self, lat, lon):
        lat = np.atleast_1d(np.asarray(lat, dtype=np.float64))
        lon = np.atleast_1d(np.asarray(lon, dtype=np.float64))
        row, col = self.latlon_to_pixel(lat, lon)
        h, w = self.height, self.width
        out = np.full(np.broadcast(row, col).shape, np.nan)
        if self.projection == PROJ_EQUIRECT:
            row = np.clip(row, 0.0, h - 1.0)
        ok = (row >= 0) & (row <= h - 1)
        if not self.wraps_longitude:
            ok &= (col >= 0) & (col <= w - 1)
        r0 = np.clip(np.floor(row), 0, h - 2).astype(np.int64)
        fr = row - r0
        if self.wraps_longitude:
            c0 = np.floor(col).astype(np.int64)
            fc = col - c0
            c0 %= w
            c1 = (c0 + 1) % w
        else:
            c0 = np.clip(np.floor(col), 0, w - 2).astype(np.int64)
            fc = col - c0
            c1 = c0 + 1
        idx = np.nonzero(ok)
        r0s, fr_s, c0s, c1s, fc_s = r0[idx], fr[idx], c0[idx], c1[idx], fc[idx]
        v00 = self.data[r0s, c0s].astype(np.float64)
        v01 = self.data[r0s, c1s].astype(np.float64)
        v10 = self.data[r0s + 1, c0s].astype(np.float64)
        v11 = self.data[r0s + 1, c1s].astype(np.float64)
        val = (v00 * (1 - fc_s) + v01 * fc_s) * (1 - fr_s) + (v10 * (1 - fc_s) + v11 * fc_s) * fr_s
        if self.nodata is not None:
            bad = (v00 == self.nodata) | (v01 == self.nodata) | (v10 == self.nodata) | (v11 == self.nodata)
            val[bad] = np.nan
        out[idx] = val * self.scale + self.offset
        return out

    def kernel_params(self) -> np.ndarray:
        if self.projection == PROJ_EQUIRECT:
            proj, a, b, c = 0.0, self.lat_top, self.lon_left, self.ppd
        else:
            proj = 1.0 if self.pole == "S" else 2.0
            a, b, c = self.x0_m, self.y0_m, self.m_per_px
        return np.array([proj, self.scale, self.offset, a, b, c, self.width, self.height,
                         1.0 if self.wraps_longitude else 0.0,
                         np.nan if self.nodata is None else float(self.nodata), self.radius_m])

    def describe(self) -> str:
        return f"{self.name} {self.resolution_m:.0f} m/px"


    @classmethod
    def from_pds(cls, img_path: Path, name: str | None = None) -> "Raster":
        img_path = Path(img_path)
        lbl = parse_pds3_label(img_path.with_suffix(".lbl").read_text(errors="replace"))
        get = lambda k: next(v for kk, v in lbl.items() if kk.endswith(k))
        lines, samples = int(get("IMAGE/LINES")), int(get("IMAGE/LINE_SAMPLES"))
        if get("IMAGE/SAMPLE_TYPE") != "LSB_INTEGER" or int(get("IMAGE/SAMPLE_BITS")) != 16:
            raise ValueError(f"{img_path.name}: only LSB int16 images are supported")
        data = np.memmap(img_path, dtype="<i2", mode="r", shape=(lines, samples))
        scale = float(get("IMAGE/SCALING_FACTOR"))
        offset_radius = float(get("IMAGE/OFFSET"))
        offset = 0.0 if offset_radius > 1e6 else offset_radius
        radius = float(get("A_AXIS_RADIUS")) * 1000.0
        ptype = get("MAP_PROJECTION_TYPE")
        name = name or str(lbl.get("PRODUCT_ID", img_path.stem)).upper()
        common = dict(name=name, data=data, scale=scale, offset=offset, radius_m=radius,
                      source=img_path.name, meta=lbl)
        line_off = float(get("LINE_PROJECTION_OFFSET"))
        samp_off = float(get("SAMPLE_PROJECTION_OFFSET"))
        if ptype == "SIMPLE CYLINDRICAL":
            ppd = float(get("MAP_RESOLUTION"))
            lat_top = float(get("CENTER_LATITUDE")) + (line_off + 0.5) / ppd
            lon_left = float(get("CENTER_LONGITUDE")) - (samp_off + 0.5) / ppd
            return cls(projection=PROJ_EQUIRECT, ppd=ppd, lat_top=lat_top, lon_left=lon_left, **common)
        if ptype == "POLAR STEREOGRAPHIC":
            mpp = float(get("MAP_SCALE"))
            pole = "S" if float(get("CENTER_LATITUDE")) < 0 else "N"
            return cls(projection=PROJ_POLAR, pole=pole, m_per_px=mpp,
                       x0_m=-samp_off * mpp, y0_m=line_off * mpp, **common)
        raise ValueError(f"{img_path.name}: unsupported projection {ptype!r}")

    @classmethod
    def from_header(cls, header_path: Path) -> "Raster":
        header_path = Path(header_path)
        hdr = json.loads(header_path.read_text())
        f = header_path.with_name(hdr["file"])
        if f.suffix == ".npy":
            data = np.load(f, mmap_mode="r")
        elif f.name.endswith(".gz"):
            data = np.frombuffer(gzip.decompress(f.read_bytes()), dtype="<i2").reshape(hdr["height"], hdr["width"])
        else:
            data = np.memmap(f, dtype="<i2", mode="r", shape=(hdr["height"], hdr["width"]))
        kw = dict(name=hdr.get("name", header_path.stem), data=data, scale=hdr.get("scale", 1.0),
                  offset=hdr.get("offset", 0.0), nodata=hdr.get("nodata"), radius_m=hdr["radius_m"],
                  source=hdr.get("source", ""), meta=hdr)
        if hdr["projection"] == PROJ_EQUIRECT:
            return cls(projection=PROJ_EQUIRECT, ppd=hdr["ppd"], lat_top=hdr.get("lat_top", 90.0),
                       lon_left=hdr.get("lon_left", -180.0), **kw)
        return cls(projection=PROJ_POLAR, pole=hdr["pole"], m_per_px=hdr["m_per_px"],
                   x0_m=hdr["x0_m"], y0_m=hdr["y0_m"], **kw)

    def header(self, file_name: str) -> dict:
        hdr = {"format": "lunarnav-dem-1", "projection": self.projection,
               "pole": self.pole if self.projection == PROJ_POLAR else None,
               "width": self.width, "height": self.height, "radius_m": self.radius_m}
        if self.projection == PROJ_EQUIRECT:
            hdr.update(ppd=self.ppd, lat_top=self.lat_top, lon_left=self.lon_left)
        else:
            hdr.update(m_per_px=self.m_per_px, x0_m=self.x0_m, y0_m=self.y0_m)
        hdr.update(nodata=self.nodata, source=self.source, file=file_name)
        return hdr


def write_cache(raster: Raster, data: np.ndarray, name: str, *, scale: float, source: str) -> Raster:
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    npy = DERIVED_DIR / f"{name}.npy"
    np.save(npy, data)
    out = Raster(**{**raster.__dict__, "name": name, "data": np.load(npy, mmap_mode="r"),
                    "scale": scale, "offset": 0.0, "source": source, "meta": {}})
    hdr = out.header(npy.name)
    hdr.update(name=name, scale=scale, offset=0.0)
    (DERIVED_DIR / f"{name}.json").write_text(json.dumps(hdr, indent=1))
    return out


def open_cache(name: str) -> Raster | None:
    hdr = DERIVED_DIR / f"{name}.json"
    if not hdr.exists() or not (DERIVED_DIR / f"{name}.npy").exists():
        return None
    return Raster.from_header(hdr)


def block_mean(raster: Raster, factor: int, name: str, *, origin: tuple = (0, 0),
               rows_per_chunk: int = 2048) -> Raster:
    cached = open_cache(name)
    if cached is not None:
        return cached
    f = int(factor)
    r_org, c_org = origin
    h, w = (raster.height - r_org) // f, (raster.width - c_org) // f
    out = np.empty((h, w), dtype=np.int16)
    step = max(1, rows_per_chunk // f)
    for i0 in range(0, h, step):
        i1 = min(h, i0 + step)
        blk = np.asarray(raster.data[r_org + i0 * f:r_org + i1 * f, c_org:c_org + w * f],
                         dtype=np.float64).reshape(i1 - i0, f, w, f)
        if raster.nodata is not None:
            valid = blk != raster.nodata
            s = np.where(valid, blk, 0.0).sum(axis=(1, 3))
            n = valid.sum(axis=(1, 3))
            m = np.where(n > 0, s / np.maximum(n, 1), raster.nodata)
        else:
            m = blk.mean(axis=(1, 3))
        out[i0:i1] = np.clip(np.rint(m), -32767, 32767).astype(np.int16)
    geo = {**raster.__dict__}
    if raster.projection == PROJ_EQUIRECT:
        geo["ppd"] = raster.ppd / f
        geo["lat_top"] = raster.lat_top - r_org / raster.ppd
        geo["lon_left"] = raster.lon_left + c_org / raster.ppd
    else:
        geo["m_per_px"] = raster.m_per_px * f
        geo["x0_m"] = raster.x0_m + (c_org + (f - 1) / 2.0) * raster.m_per_px
        geo["y0_m"] = raster.y0_m - (r_org + (f - 1) / 2.0) * raster.m_per_px
    base = Raster(**geo)
    return write_cache(base, out, name, scale=raster.scale,
                       source=f"{raster.source} block-mean {f}x{f}")


def _geotiff_to_cache(tif_path: Path, name: str, scale: float = 0.5) -> Raster:
    import tifffile

    cached = open_cache(name)
    if cached is not None:
        return cached
    with tifffile.TiffFile(tif_path) as tif:
        page = tif.pages[0]
        h, w = page.shape[:2]
        sx, sy = page.tags["ModelPixelScaleTag"].value[:2]
        tie = page.tags["ModelTiepointTag"].value
        geokeys = page.geotiff_tags or {}
        nodata_tag = page.tags.get("GDAL_NODATA")
        nodata_val = float(nodata_tag.value) if nodata_tag is not None else None
        if abs(sx - sy) > 1e-9:
            raise ValueError("non-square pixels are not supported")
        center_lat = None
        for k in ("ProjNatOriginLatGeoKey", "ProjCenterLatGeoKey", "ProjStraightVertPoleLongGeoKey"):
            if k in geokeys and "Lat" in k:
                center_lat = float(geokeys[k])
        citation = " ".join(str(geokeys.get(k, "")) for k in ("GTCitationGeoKey", "PCSCitationGeoKey",
                                                              "GeogCitationGeoKey"))
        if center_lat is None:
            center_lat = -90.0 if ("south" in citation.lower() or "-90" in citation) else 90.0
        semi = geokeys.get("GeogSemiMajorAxisGeoKey", MOON_RADIUS_M)
        DERIVED_DIR.mkdir(parents=True, exist_ok=True)
        npy = DERIVED_DIR / f"{name}.npy"
        out = np.lib.format.open_memmap(npy, mode="w+", dtype=np.int16, shape=(h, w))
        bad_total = 0
        for seg, idx, shape in page.segments(maxworkers=4):
            if seg is None:
                continue
            y0, x0 = idx[2], idx[3]
            blk = np.asarray(seg, dtype=np.float64).reshape(shape[-3], shape[-2])
            th, tw = min(blk.shape[0], h - y0), min(blk.shape[1], w - x0)
            blk = blk[:th, :tw]
            bad = ~np.isfinite(blk)
            if nodata_val is not None:
                bad |= blk == nodata_val
            bad_total += int(bad.sum())
            dn = np.where(bad, NODATA_I16, np.clip(np.rint(blk / scale), -32767, 32767))
            out[y0:y0 + th, x0:x0 + tw] = dn.astype(np.int16)
        out.flush()
        del out
    pole = "S" if center_lat < 0 else "N"
    raster = Raster(name=name, data=np.zeros((h, w), np.int16), projection=PROJ_POLAR, pole=pole,
                    m_per_px=float(sx), x0_m=float(tie[3]) + sx / 2.0, y0_m=float(tie[4]) - sy / 2.0,
                    radius_m=float(semi), nodata=NODATA_I16 if bad_total else None,
                    scale=scale, source=tif_path.name)
    hdr = raster.header(npy.name)
    hdr.update(name=name, scale=scale, offset=0.0, nodata_pixels=bad_total)
    (DERIVED_DIR / f"{name}.json").write_text(json.dumps(hdr, indent=1))
    return Raster.from_header(DERIVED_DIR / f"{name}.json")


def open_product(key: str, *, download: bool = True) -> Raster:
    path = local_path(key)
    if not path.exists():
        if not download:
            raise FileNotFoundError(f"{path} missing; run `python -m lunarnav build-dem` first")
        fetch(key)
    if path.suffix.lower() == ".tif":
        r = _geotiff_to_cache(path, key)
    else:
        r = Raster.from_pds(path)
    r.source = f"{PRODUCTS[key].title}"
    return r


def global_dem() -> Raster:
    r = open_product("ldem_128")
    r.name = "LDEM_128"
    return r


def polar_dem(pole: str) -> Raster:
    if pole == "S":
        r = open_product("ldem_80s_20m_adj")
        r.name = "LDEM_80S_20MPP_ADJ"
    else:
        r = open_product("ldem_80n_20m")
        r.name = "LDEM_80N_20M"
    return r


WEB_GLOBAL_PPD = 8
WEB_POLAR_SIZE_PX = 2560
WEB_POLAR_M_PER_PX = 240.0
WEB_POLAR_X0_M = -(WEB_POLAR_SIZE_PX / 2 - 0.5) * WEB_POLAR_M_PER_PX


def polar_block_origin(fine: Raster, factor: int) -> tuple[int, int]:
    edge_web = WEB_POLAR_X0_M - WEB_POLAR_M_PER_PX / 2.0
    edge_fine_x = fine.x0_m - fine.m_per_px / 2.0
    edge_fine_y = fine.y0_m + fine.m_per_px / 2.0
    if abs(factor * fine.m_per_px - WEB_POLAR_M_PER_PX) > 1e-6:
        raise ValueError("block size must equal the web pixel size")
    c = (edge_web - edge_fine_x) / fine.m_per_px
    r = (edge_fine_y + edge_web) / fine.m_per_px
    c_org, r_org = int(round(c % factor)), int(round(r % factor))
    if abs(c - round(c)) > 1e-6 or abs(r - round(r)) > 1e-6:
        raise ValueError("fine grid is not aligned to the web grid on whole pixels")
    return r_org, c_org


def polar_240(fine: Raster) -> Raster:
    factor = int(round(WEB_POLAR_M_PER_PX / fine.m_per_px))
    r = block_mean(fine, factor, f"{fine.name.lower()}_x{factor}",
                   origin=polar_block_origin(fine, factor))
    r.name = f"{fine.name} {factor}x{factor} mean"
    return r


def _write_web_grid(raster: Raster, metres: np.ndarray, key: str, source: str) -> dict:
    from .constants import WEB_DATA_DIR

    out_dir = WEB_DATA_DIR / "dem"
    out_dir.mkdir(parents=True, exist_ok=True)
    grid = np.clip(np.rint(metres), -32767, 32767).astype("<i2")
    gz = out_dir / f"{key}.i16.gz"
    with open(gz, "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as z:
            z.write(grid.tobytes())
    hdr = {"format": "lunarnav-dem-1", "projection": raster.projection,
           "pole": raster.pole if raster.projection == PROJ_POLAR else None,
           "width": int(grid.shape[1]), "height": int(grid.shape[0]), "radius_m": MOON_RADIUS_M}
    if raster.projection == PROJ_EQUIRECT:
        hdr["ppd"] = raster.ppd
    else:
        hdr.update(m_per_px=raster.m_per_px, x0_m=raster.x0_m, y0_m=raster.y0_m)
    hdr.update(nodata=NODATA_I16, units="m above 1737.4 km sphere, int16 little-endian",
               min_m=int(grid.min()), max_m=int(grid.max()), source=source, file=gz.name)
    (out_dir / f"{key}.json").write_text(json.dumps(hdr, indent=1))
    return hdr


def build_web_global() -> dict:
    g = global_dem()
    factor = int(round(g.ppd / WEB_GLOBAL_PPD))
    coarse = block_mean(g, factor, f"ldem_128_x{factor}")
    metres = np.asarray(coarse.data, dtype=np.float64) * coarse.scale + coarse.offset
    shift = int(round(((-180.0 - coarse.lon_left) % 360.0) * coarse.ppd))
    metres = np.roll(metres, -shift, axis=1)
    geo = Raster(name="global", data=metres, projection=PROJ_EQUIRECT, ppd=coarse.ppd,
                 lat_top=90.0, lon_left=-180.0)
    return _write_web_grid(geo, metres, "global",
                           f"LOLA LDEM_128 (PDS, 236.9 m/px) area-averaged {factor}x{factor} to "
                           f"{WEB_GLOBAL_PPD} px/deg")


def build_web_polar(pole: str) -> dict:
    fine = polar_dem(pole)
    coarse = polar_240(fine)
    n = WEB_POLAR_SIZE_PX
    web = Raster(name=pole, data=np.zeros((1, 1), np.int16), projection=PROJ_POLAR, pole=pole,
                 m_per_px=WEB_POLAR_M_PER_PX, x0_m=WEB_POLAR_X0_M, y0_m=-WEB_POLAR_X0_M)
    metres = np.full((n, n), np.nan)
    j0 = int(round((coarse.x0_m - web.x0_m) / web.m_per_px))
    i0 = int(round((web.y0_m - coarse.y0_m) / web.m_per_px))
    vals = np.asarray(coarse.data, dtype=np.float64)
    vals = np.where(vals == coarse.nodata, np.nan, vals * coarse.scale) if coarse.nodata is not None \
        else vals * coarse.scale
    ii0, jj0 = max(i0, 0), max(j0, 0)
    ii1, jj1 = min(i0 + coarse.height, n), min(j0 + coarse.width, n)
    metres[ii0:ii1, jj0:jj1] = vals[ii0 - i0:ii1 - i0, jj0 - j0:jj1 - j0]
    missing = ~np.isfinite(metres)
    rows, cols = np.nonzero(missing)
    lat, lon = web.pixel_to_latlon(rows, cols)
    metres[rows, cols] = global_dem().sample(lat, lon)
    web.data = metres
    prod = "LDEM_80S_20MPP_ADJ (PGDA, 20 m/px)" if pole == "S" else "LDEM_80N_20M (PDS, 20 m/px)"
    return _write_web_grid(web, metres, "south" if pole == "S" else "north",
                           f"LOLA {prod} area-averaged 12x12 to 240 m/px; "
                           f"{missing.mean() * 100:.1f}% of pixels (outside the 20 m grid) from LDEM_128")
