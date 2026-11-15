# Terrain validation

## Data products used

| Product | Resolution | Coverage | Size | Source / citation |
|---|---|---|---|---|
| LOLA `LDEM_80S_20MPP_ADJ` (crossover-adjusted) | 20 m/px, polar stereographic | 80–90° S | 2.70 GB GeoTIFF (float32) | https://pgda.gsfc.nasa.gov/products/90 — Barker et al. (2021), *Planet. Space Sci.* 203, 105119 |
| LOLA `LDEM_80N_20M` | 20 m/px, polar stereographic | 80–90° N | 1.85 GB PDS IMG (int16, 0.5 m) | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ — Smith et al. (2010, 2017) |
| LOLA `LDEM_128` | 128 px/deg (236.9 m) | global | 2.12 GB PDS IMG | …/lola_gdr/cylindrical/img/ |
| LOLA `AVGVISIB_65S_240M_201608` (+`_EARTH`) | 240 m/px | 65–90° S | 82 MB each | …/extras/illumination/img/ — Mazarico et al. (2011), *Icarus* 211, 1066 |
| NASA SVS CGI Moon Kit LROC colour map (2025) | 4096 × 2048 | global | 62 MB | https://svs.gsfc.nasa.gov/4720 (public domain) |

All LOLA heights are metres above the 1737.4 km sphere in the ME frame of DE421; the
difference to the DE440 ME frame is a few metres, far below every grid resolution.
Products are downloaded to `data_raw/lola/` by `python -m lunarnav build-dem` (resumable,
parallel byte ranges); derived block means are cached in `data_raw/lola/derived/`.

## Web grids (`web/data/dem`, §4.2)

* `global` — LDEM_128 area-averaged 16 × 16 → 8 px/deg (3.79 km), re-centred to −180…180; 7.1 MB gz.
* `south`, `north` — 2560 × 2560 px, 240 m/px, half-width 307.2 km (|lat| ≥ 79.9° on the
  axes, ≥ 75.7° in the corners). Exact 12 × 12 area means of the 20 m DEMs; the 1–2 % of
  corner pixels outside the 20 m data are sampled from LDEM_128. 10.4 / 9.8 MB gz.
  Median polar-vs-LDEM_128 height difference at 80.5–86° S: −0.4 m (75th pct. of |Δ| 2.8 m).

## Algorithm (`lunarnav/horizon.py`, `web/js/core/terrain.js`)

For every azimuth the great circle from the site is marched as
`p(θ) = cos θ·u + sin θ·(cos A·n + sin A·e)` (exact across the poles and ±180°). Heights are
bilinear in the first *tier* that covers the point; the step is half that tier's pixel.
A terrain point at radius r is seen at `tan(el) = (r cos θ − r_obs)/(r sin θ)`, the elevation
above the local horizontal plane including curvature; `r_obs = R + h_site + 2 m`.
The ray stops when even an 11 km summit (lunar maximum 10.79 km) could no longer exceed the
running maximum — a rigorous bound; observed ray lengths are 95–366 km (hard cap 400 km
Python, 300 km JS default; `sqrt(2R·5 km) + sqrt(2R·11 km) ≈ 328 km` for an observer on a
5 km massif).

High-resolution tiers (precomputed horizons): polar sites — 20 m data < 30 km, its 60 m mean
< 100 km, its 240 m mean beyond, LDEM_128 outside the 20 m grid; other sites — LDEM_128.
Web tiers (browser): the polar web grid of the hemisphere for |lat| ≥ 60°, then the global grid.
Precomputed sites: 62/62 from `web/data/sites.json` (35 LDEM_128 only, 27 using the 20 m polar
DEMs); 0.5° azimuth step, 0.01° precision, ~0.3 s per site after JIT compilation.

## Accuracy

Smooth-sphere check: the computed horizon equals the dip `−acos(R/(R+h))` within 0.002° for
h = 2 m … 5 km, on both projections (`tests/python/test_horizon.py`).

JS vs Python on the same web grids (8 sites, 1° step): RMS 0.0000°, max 0.0000° (identical
double-precision arithmetic). JS time 1–194 ms per horizon in node (target < 2 s).

Web resolution vs high resolution (`tests/fixtures/horizon_reference.json`), web − high, degrees:

| Site | all terrain RMS / max | terrain beyond 1 km RMS / max |
|---|---|---|
| Shackleton rim (−89.78, −155.7) | 6.91 / 9.79 | 0.08 / 0.43 |
| Malapert massif | 0.80 / 1.93 | 0.07 / 0.31 |
| near 80° S boundary | 0.32 / 0.96 | 0.09 / 0.31 |
| polar-grid corner (−77, 45) | 0.22 / 0.72 | 0.08 / 0.28 |
| Peary (88.6 N) | 0.49 / 1.24 | 0.06 / 0.22 |
| Apollo 15 | 0.93 / 3.08 | 0.93 / 3.08 |
| Tsiolkovskiy (far side) | 3.57 / 8.60 | 3.57 / 8.60 |
| near ±180° (5 N, 179.9 E) | 4.40 / 7.97 | 4.40 / 7.94 |

* Polar web grids reproduce the skyline beyond 1 km to < 0.1° RMS. Differences closer in are
  the local slope/micro-relief resolved only at 20 m: at (−89.78, −155.7) the 20 m DEM puts the
  observer in a ~10 m deep hollow, giving a 3–8° near-field horizon all around that the 240 m
  grid cannot show (Shackleton rim site SR1 nearby: high-res horizon −2.6…+1.1°).
* The 8 px/deg global grid smooths mid-latitude relief: rugged sites (central peaks, crater
  walls) are 2–4° low on average. Catalog sites therefore always use the precomputed
  high-resolution profiles; ad-hoc mid-latitude horizons are indicative.
* Physical checks: Apollo 15 sees Mons Hadley Delta 12–13.5° high to the south; Shackleton
  rim SR1 stays within ±3°.

## Limitations

* No terrain closer than half a DEM pixel (10 m polar, 118 m LDEM_128) is considered; the
  near field is DEM-limited (LOLA effective resolution is coarser than 20 m between tracks).
* LDEM_128 (237 m) limits mid-latitude precomputed horizons; LOLA 1024 px/deg tiles would
  improve near-field accuracy at Apollo-type sites.
* Block averaging lowers sharp distant peaks slightly (≤ ~0.02° at > 100 km).
* Spherical reference body, no refraction (none on the Moon); LOLA DE421 ME frame used as-is.
