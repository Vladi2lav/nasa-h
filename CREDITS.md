# Credits and references

Everything this project uses that was not written by the team, with its source and
licence. All NASA data below is in the public domain unless noted.

## NASA data

| Resource | Used for | Source |
|---|---|---|
| NAIF SPICE generic kernels: `de440s.bsp`, `moon_pa_de440_200625.bpc`, `moon_de440_250416.tf`, `naif0012.tls`, `pck00011.tpc`, `earth_1962_260806_2126_combined.bpc` | Sun and Earth positions in the lunar Mean-Earth frame, Earth orientation for ground stations | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ |
| LRO LOLA `LDEM_80S_20MPP_ADJ` (20 m/px south pole) | Terrain horizons of south-polar sites | https://pgda.gsfc.nasa.gov/products/90 |
| LRO LOLA `LDEM_80N_20M`, `LDEM_128` | Terrain horizons elsewhere; in-browser elevation grids | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/ |
| LRO LOLA `AVGVISIB_65S_240M` | South-pole average Sun / Earth visibility layers | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/ |
| NASA SVS CGI Moon Kit (LROC WAC colour mosaic) | Globe and map imagery | https://svs.gsfc.nasa.gov/4720 |
| JPL Horizons System API | Validation of computed angles; spacecraft trajectories | https://ssd.jpl.nasa.gov/horizons/ |
| NASA NSSDCA master catalog, LROC image releases | Landing-site coordinates and dates (each entry in `web/data/sites.json` names its own source) | https://nssdc.gsfc.nasa.gov/nmc/ , https://www.lroc.asu.edu/ |
| JPL DSN 810-005, NAIF station kernels | NASA Deep Space Network station positions | https://deepspace.jpl.nasa.gov/dsndocs/810-005/ |

## Space agency partner data

| Resource | Used for | Source |
|---|---|---|
| ESA ESTRACK station kernel (`estrack_v07.tf`) | New Norcia, Cebreros, Malargüe, Goonhilly, Byalalu positions | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/stations/ |
| JAXA / ISAS station pages | Usuda and Misasa deep-space stations | https://www.isas.jaxa.jp/ |
| KARI KDSA kernel (`kdsa01.tf`) | Korea Deep Space Antenna | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/stations/ |

## Software

| Component | Licence | Source |
|---|---|---|
| three.js r160 (`web/vendor/`) | MIT (`web/vendor/THREE_LICENSE`) | https://threejs.org |
| NumPy, SciPy, Numba, SpiceyPy, Pillow, tifffile, imagecodecs, requests, pytest | BSD / MIT / Apache 2.0 | https://pypi.org |

## Literature

- Acton, C. (1996). Ancillary data services of NASA's Navigation and Ancillary Information Facility. *Planetary and Space Science* 44(1).
- Park, R. S. et al. (2021). The JPL Planetary and Lunar Ephemerides DE440 and DE441. *AJ* 161:105. https://doi.org/10.3847/1538-3881/abd414
- Smith, D. E. et al. (2010). Initial observations from the Lunar Orbiter Laser Altimeter. *GRL* 37:L18204. https://doi.org/10.1029/2010GL043751
- Barker, M. K. et al. (2021). Improved LOLA elevation maps for south pole landing sites. *PSS* 203:105119. https://doi.org/10.1016/j.pss.2020.105119
- Mazarico, E. et al. (2011). Illumination conditions of the lunar polar regions using LOLA topography. *Icarus* 211. https://doi.org/10.1016/j.icarus.2010.10.030

## Use of AI tools

An AI coding assistant (Claude, by Anthropic) was used to help write and review parts of
the source code, tests and documentation. All numerical results come from the NASA data
listed above and are validated against the JPL Horizons System
(`docs/VALIDATION_EPHEMERIS.md`). No AI-generated images, video or audio are used.

## Disclaimer

This project is not affiliated with or endorsed by NASA. It uses no NASA logos,
insignia or mission emblems.
