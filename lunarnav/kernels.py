from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

import requests
import spiceypy as spice

from .constants import RAW_DIR

NAIF_BASE_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
KERNEL_DIR = RAW_DIR / "kernels"
USER_AGENT = "lunarnav-data-pipeline/1.0 (+https://naif.jpl.nasa.gov)"
_TIMEOUT_S = 60
_CHUNK_BYTES = 1 << 20


@dataclass(frozen=True)
class KernelSpec:

    role: str
    subdir: str
    pattern: str


KERNEL_SPECS: tuple[KernelSpec, ...] = (
    KernelSpec("leapseconds", "lsk/", r"naif0012\.tls"),
    KernelSpec("constants", "pck/", r"pck00011\.tpc"),
    KernelSpec("planets", "spk/planets/", r"de440s\.bsp"),
    KernelSpec("moon_orientation", "pck/", r"moon_pa_de440_200625\.bpc"),
    KernelSpec("moon_frames", "fk/satellites/", r"moon_de440_\d{6}\.tf"),
    KernelSpec("earth_orientation", "pck/", r"earth_1962_\d{6}_2126_combined\.bpc"),
)

_loaded: list[str] | None = None


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def _list_remote(session: requests.Session, subdir: str) -> list[str]:
    resp = session.get(NAIF_BASE_URL + subdir, timeout=_TIMEOUT_S)
    resp.raise_for_status()
    return sorted(set(re.findall(r'href="([^"/?]+)"', resp.text)))


def _newest(names, pattern: str) -> str | None:
    rx = re.compile(pattern + r"\Z")
    matches = sorted(n for n in names if rx.match(n))
    return matches[-1] if matches else None


def _download(session: requests.Session, url: str, dest: Path, log) -> None:
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with session.get(url, headers=headers, stream=True, timeout=_TIMEOUT_S) as resp:
        if resp.status_code == 416:
            part.replace(dest)
            return
        resp.raise_for_status()
        if have and resp.status_code != 206:
            have = 0
        total = have + int(resp.headers.get("Content-Length", 0))
        mode = "ab" if have else "wb"
        done = have
        with open(part, mode) as fh:
            for block in resp.iter_content(_CHUNK_BYTES):
                fh.write(block)
                done += len(block)
                if total:
                    log(f"\r  {dest.name}: {done / 1e6:7.1f} / {total / 1e6:.1f} MB", end="")
        log("")
    if total and part.stat().st_size != total:
        raise IOError(f"incomplete download of {url}: {part.stat().st_size} of {total} bytes")
    part.replace(dest)


def ensure_kernels(kernel_dir: Path = KERNEL_DIR, verbose: bool = True) -> list[Path]:
    kernel_dir.mkdir(parents=True, exist_ok=True)

    def log(msg, end="\n"):
        if verbose:
            print(msg, end=end, file=sys.stderr, flush=True)

    local = [p.name for p in kernel_dir.iterdir() if p.is_file()]
    session = None
    listings: dict[str, list[str]] = {}
    paths = []
    for spec in KERNEL_SPECS:
        name = _newest(local, spec.pattern)
        if name is None:
            session = session or _session()
            if spec.subdir not in listings:
                listings[spec.subdir] = _list_remote(session, spec.subdir)
            name = _newest(listings[spec.subdir], spec.pattern)
            if name is None:
                raise FileNotFoundError(
                    f"no file matching {spec.pattern!r} in {NAIF_BASE_URL}{spec.subdir}")
            log(f"downloading {spec.subdir}{name}")
            _download(session, NAIF_BASE_URL + spec.subdir + name, kernel_dir / name, log)
        paths.append(kernel_dir / name)
    return paths


def furnish(kernel_dir: Path = KERNEL_DIR, verbose: bool = False) -> list[str]:
    global _loaded
    if _loaded is None:
        paths = ensure_kernels(kernel_dir, verbose=verbose)
        for p in paths:
            spice.furnsh(str(p))
        _loaded = [p.name for p in paths]
    return list(_loaded)
