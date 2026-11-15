# Lunar Landing Site Navigator

Compare lunar landing sites and dates in seconds: where the Sun and the Earth are
relative to the **real terrain horizon**, how long until sunset or Earthset, how much
solar power and direct-to-Earth communication a site offers — and what happens when
the landing date slips.

Built for the NASA Space Apps Challenge 2026, challenge
[Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/).

## What it does

| Question | Where |
|---|---|
| Is the site sunlit / in contact with Earth right now, and for how long? | Explore: status card with countdowns to sunset, sunrise, Earthset, Earthrise |
| Where exactly are the Sun and Earth against the skyline? | Sky panorama: 360° terrain horizon from LOLA, bodies drawn to angular scale, tracks over the next lunar day |
| How do conditions evolve over a mission? | Timeline: elevation above terrain, sunlit / link bands, events |
| Which site or date is better? | Compare: side-by-side KPIs, ranking score, plain-English verdict |
| Our launch slipped — when can we still land? | Plan: landing-window scan against editable requirements, year heatmap |
| Why is the south pole so hard? | Learn: short explanations driven by live numbers |
| How do Earth, Moon and Sun line up, and what is flying there now? | Globe: zoom out to the Earth at true size and distance; live markers for spacecraft in lunar orbit (JPL Horizons) and Artemis III regions |
| Where is it? | 3D globe with the real terminator, global map, south and north polar maps |

62 catalog sites (Apollo, Luna, Surveyor, Chang'e, Chandrayaan, SLIM, CLPS and commercial
landers, Artemis III candidate regions, reference features), any custom coordinates,
13 deep-space ground stations (NASA DSN, ESA ESTRACK, JAXA, ISRO, KASA, UK).
Dates from 1969 to 2060. Every view is shareable as a link; data exports as CSV/JSON.

## Run it

It is a static web app — no backend, no build step, works offline.

```bash
python -m http.server 8080 --directory web
```

Then open <http://localhost:8080>. Submission materials (slide deck PDF, screenshots,
form texts) are in `submission.rar`. To publish, enable GitHub Pages for the repository
root; the app is served at `/web/`.

## Data (all real, all reproducible)

| Data | Source | Used for |
|---|---|---|
| Planetary ephemeris DE440, lunar orientation `moon_pa_de440`, lunar frame kernel, Earth orientation | NASA/JPL NAIF SPICE generic kernels | Sun and Earth positions in the lunar Mean-Earth frame; Moon direction for ground stations |
| LOLA elevation models: `LDEM_80S_20MPP_ADJ` (PGDA, 20 m/px), `LDEM_80N_20M`, `LDEM_128` (PDS) | NASA LRO / LOLA | Terrain horizon of every site; in-browser horizons for custom sites |
| LOLA average Sun / Earth visibility (`AVGVISIB_65S_240M`) | NASA LRO / LOLA | South-pole map overlays |
| LROC WAC colour mosaic (CGI Moon Kit, SVS 4720) | NASA SVS / LROC | Globe and map basemap |
| JPL Horizons API | NASA/JPL SSD | Independent validation |

Rebuild everything from the NASA sources:

```bash
pip install -e .
python -m lunarnav kernels
python -m lunarnav build-ephem
python -m lunarnav build-dem
python -m lunarnav build-maps
python -m lunarnav build-horizons
python -m lunarnav validate-horizons
```

Command-line use without the web app:

```bash
python -m lunarnav sky --lat -84.79 --lon 29.2 --time 2027-03-01T00:00:00Z
```

## Accuracy

| Check | Result |
|---|---|
| Sun / Earth azimuth-elevation vs JPL Horizons (7 sites, 1969–2040) | max 0.0002° |
| Browser engine vs SPICE | max 0.0000015° |
| Browser horizon vs Python reference on the same grid | identical |
| Apollo 11 landing Sun elevation | 10.70° (Horizons 10.70°) |

Catalog sites use horizons precomputed from the best LOLA product (20 m/px near polar
sites). Custom sites use coarser in-browser grids (240 m/px at the poles, 8 px/deg
elsewhere); the app always states which source was used. Details and limitations:
[docs/VALIDATION_EPHEMERIS.md](docs/VALIDATION_EPHEMERIS.md),
[docs/VALIDATION_TERRAIN.md](docs/VALIDATION_TERRAIN.md).

## How it works

`lunarnav` (Python) downloads the NASA data and builds compact files in `web/data/`.
The browser engine (`web/js/core/`) interpolates the SPICE ephemeris, builds the site
frame, clips the solar disc against the terrain horizon, finds rise/set events to one
second, and derives power, communication and landing-window metrics. Architecture and
data formats: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Demo slides: `web/demo/`.

Tests:

```bash
npm test
python -m pytest
```

## Limitations

- Horizons assume a 2 m observer height by default (adjustable) and the LOLA surface;
  boulders and lander-scale relief are not modelled.
- Power figures are geometric (visible fraction of the solar disc, panel orientation);
  no thermal or electrical model.
- "Link" means geometric line of sight with an elevation mask at both ends; no link
  budget.
- Ground-station elevations for far-future dates rely on predicted Earth orientation
  (about 0.3°).

## Credits

Data: NASA/JPL NAIF, NASA LRO LOLA and LROC teams, NASA Scientific Visualization
Studio, JPL Horizons. Rendering: three.js (MIT). This project is not affiliated with
or endorsed by NASA. Full list of data, software and references, and the note on
AI-assisted development: [CREDITS.md](CREDITS.md).

License: MIT.
