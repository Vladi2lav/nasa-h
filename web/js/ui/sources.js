import { escapeHtml, latlon, utc } from './format.js';

export const DATASETS = [
  {
    key: 'ephemeris', group: 'Positions of the Sun and Earth',
    name: 'NASA/JPL SPICE planetary ephemeris DE440 and lunar orientation',
    used: 'Sun and Earth azimuth, elevation and distance at every site; sub-solar and sub-Earth points; Moon elevation at ground stations.',
    detail: 'Kernels de440s.bsp, moon_pa_de440_200625.bpc, moon_de440_250416.tf (Mean-Earth frame), naif0012.tls, pck00011.tpc, earth_1962_260806_2126_combined.bpc. Sampled hourly 1969–2060 and interpolated in the browser.',
    accuracy: 'Max 0.0002° from the JPL Horizons System (7 sites, 1969–2040); browser engine within 0.0000015° of SPICE.',
    links: [
      ['NAIF generic kernels', 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/'],
      ['Park et al. 2021, DE440 (AJ 161:105)', 'https://doi.org/10.3847/1538-3881/abd414'],
    ],
  },
  {
    key: 'lola-south', group: 'Terrain horizon',
    name: 'LRO LOLA south-pole elevation model LDEM_80S_20MPP_ADJ (20 m/px)',
    used: 'Terrain horizon of catalog sites south of 80° S: 20 m/px out to 30 km, averaged to 60 m and 240 m farther out.',
    detail: 'Barker et al. 2021 adjusted south-pole DEM, NASA Planetary Geodynamics Data Archive product 90.',
    accuracy: 'Horizon from the 240 m web grid differs from the 20 m horizon by 0.06–0.09° RMS beyond 1 km.',
    links: [
      ['NASA PGDA product 90', 'https://pgda.gsfc.nasa.gov/products/90'],
      ['Barker et al. 2021 (PSS 203:105119)', 'https://doi.org/10.1016/j.pss.2020.105119'],
    ],
  },
  {
    key: 'lola-north', group: 'Terrain horizon',
    name: 'LRO LOLA north-pole elevation model LDEM_80N_20M (20 m/px)',
    used: 'Terrain horizon of catalog sites north of 80° N.',
    detail: 'PDS LOLA gridded data record, polar stereographic.',
    links: [['PDS Geosciences Node — LOLA GDR', 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/']],
  },
  {
    key: 'lola-global', group: 'Terrain horizon',
    name: 'LRO LOLA global elevation model LDEM_128 (237 m/px)',
    used: 'Terrain horizon of all other catalog sites, far-field terrain of polar sites, and in-browser horizons of custom coordinates (8 px/deg grid).',
    detail: 'Smith et al. 2010; PDS LOLA gridded data record, simple cylindrical.',
    accuracy: 'The 8 px/deg browser grid smooths rugged terrain: up to ~4° lower horizon at mid-latitudes. Catalog sites therefore use precomputed 237 m horizons.',
    links: [
      ['PDS Geosciences Node — LOLA GDR', 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/'],
      ['Smith et al. 2010 (GRL 37:L18204)', 'https://doi.org/10.1029/2010GL043751'],
    ],
  },
  {
    key: 'lola-illum', group: 'Map layers',
    name: 'LRO LOLA average Sun and Earth visibility, south pole (AVGVISIB_65S_240M)',
    used: 'South-pole map overlays "Average Sun visibility" and "Average Earth visibility".',
    links: [['PDS Geosciences Node — LOLA', 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/']],
  },
  {
    key: 'basemap', group: 'Map layers',
    name: 'LROC WAC colour mosaic — NASA SVS CGI Moon Kit',
    used: 'Globe and global map imagery.',
    links: [['NASA Scientific Visualization Studio 4720', 'https://svs.gsfc.nasa.gov/4720']],
  },
  {
    key: 'spacecraft', group: 'Spacecraft',
    name: 'Spacecraft trajectories — JPL Horizons System',
    used: 'Positions of spacecraft in lunar orbit on the globe (5-minute steps), rotated into the lunar Mean-Earth frame with SPICE.',
    links: [['JPL Horizons System', 'https://ssd.jpl.nasa.gov/horizons/']],
  },
  {
    key: 'sites', group: 'Catalog',
    name: 'Landing sites',
    used: 'Coordinates and landing times of past and planned missions and candidate regions; each entry links to its own source (NSSDCA, LROC, NASA, peer-reviewed papers).',
    links: [['NASA NSSDCA master catalog', 'https://nssdc.gsfc.nasa.gov/nmc/'], ['LROC featured sites', 'https://www.lroc.asu.edu/']],
  },
  {
    key: 'stations', group: 'Catalog',
    name: 'Deep-space ground stations',
    used: 'Which stations on Earth can see the Moon (elevation mask 10°). Positions from NAIF and ESA station kernels and operator pages.',
    links: [['NAIF station kernels', 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/stations/'], ['NASA DSN 810-005', 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/']],
  },
];

const link = ([label, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
const urlOf = (u) => (u && /^https?:\/\//.test(u) ? u : null);

export function mountSources(app) {
  const { nav } = app;
  let craft = null;
  const dlg = document.createElement('dialog');
  dlg.className = 'src-dialog';
  dlg.setAttribute('aria-labelledby', 'src-title');
  document.body.append(dlg);

  async function loadCraft() {
    if (craft) return craft;
    try { craft = (await (await fetch('data/spacecraft.json')).json()); } catch { craft = { spacecraft: [] }; }
    return craft;
  }

  function datasetHtml(d, open) {
    return `<details class="src-item" id="src-dataset-${d.key}" ${open ? 'open' : ''}>
      <summary><span class="src-group">${escapeHtml(d.group)}</span>${escapeHtml(d.name)}</summary>
      <dl>
        <dt>Used for</dt><dd>${escapeHtml(d.used)}</dd>
        ${d.detail ? `<dt>Details</dt><dd>${escapeHtml(d.detail)}</dd>` : ''}
        ${d.accuracy ? `<dt>Accuracy</dt><dd>${escapeHtml(d.accuracy)}</dd>` : ''}
        <dt>Primary source</dt><dd class="src-links">${d.links.map(link).join('')}</dd>
      </dl></details>`;
  }

  function entryHtml(title, rows, source) {
    const u = urlOf(source);
    return `<section class="src-entry">
      <h3>${escapeHtml(title)}</h3>
      <dl>${rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}
        <dt>Primary source</dt><dd class="src-links">${u ? link([u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70), u]) : escapeHtml(source || 'not recorded')}</dd>
      </dl></section>`;
  }

  async function focusHtml(kind, id) {
    if (kind === 'site') {
      const s = nav.sites.find((x) => x.id === id);
      if (!s) return '';
      return entryHtml(s.name, [
        ['Coordinates', latlon(s.lat, s.lon) + ' (planetocentric, Mean-Earth frame)'],
        ['Agency', [s.agency, s.country].filter(Boolean).join(' · ')],
        ['Status', s.status], ['Landing time', s.date_utc ? utc(Date.parse(s.date_utc)) : null],
        ['Region', s.region], ['About', s.description],
      ], s.source);
    }
    if (kind === 'station') {
      const s = nav.stations.find((x) => x.id === id);
      if (!s) return '';
      return entryHtml(s.name, [
        ['Network', s.network], ['Country', s.country],
        ['Position', `${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}° (geodetic, WGS84)${s.alt_m != null ? `, ${s.alt_m} m` : ', altitude not published'}`],
        ['Elevation mask', `${s.min_elevation_deg ?? 10}°`],
      ], s.source);
    }
    if (kind === 'craft') {
      const c = (await loadCraft()).spacecraft.find((x) => x.id === id);
      if (!c) return '';
      return entryHtml(c.name, [
        ['Operator', c.agency], ['About', c.info], ['Horizons id', c.horizons_id],
        ['Trajectory covers', `${utc(c.t0_ms)} – ${utc(c.t0_ms + (c.n - 1) * c.step_ms)}`],
      ], `https://ssd.jpl.nasa.gov/horizons/app.html#/?sstr=${encodeURIComponent(c.horizons_id)}`);
    }
    return '';
  }

  async function open(ref = '') {
    const [kind, id] = ref.split(':');
    const focus = kind && kind !== 'dataset' ? await focusHtml(kind, id) : '';
    dlg.innerHTML = `
      <header class="src-head">
        <h2 id="src-title">Data and sources</h2>
        <button type="button" class="icon-btn src-close" aria-label="Close">×</button>
      </header>
      <div class="src-body">
        ${focus}
        <p class="src-intro">Every number in this tool is computed from the public datasets below. Expand a dataset for what it is used for, its accuracy and the primary source.</p>
        ${DATASETS.map((d) => datasetHtml(d, kind === 'dataset' && d.key === id)).join('')}
        <p class="src-intro">Not affiliated with or endorsed by NASA.</p>
      </div>`;
    if (!dlg.open) dlg.showModal();
    const target = kind === 'dataset' ? dlg.querySelector(`#src-dataset-${CSS.escape(id || '')}`) : null;
    (target || dlg.querySelector('.src-close')).scrollIntoView({ block: 'nearest' });
    dlg.querySelector('.src-close').focus();
  }

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('.src-close')) dlg.close();
  });
  const onDoc = (e) => {
    const el = e.target.closest('[data-source]');
    if (!el || dlg.contains(el)) return;
    e.preventDefault();
    open(el.dataset.source);
  };
  const onKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-source]:not(button):not(a)')) onDoc(e);
  };
  document.addEventListener('click', onDoc);
  document.addEventListener('keydown', onKey);
  return { open, destroy() { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); dlg.remove(); } };
}
