/*
 * Locator block — Scotiabank branch / ATM / advisor finder.
 *
 * LAYOUT (mirrors locator.scotiabank.com):
 *   Left panel  — intro heading + copy, a "Search by" dropdown, an address
 *                 search input with a submit button, a "Filter results" toggle,
 *                 an appointment CTA card, and (below) the results list.
 *   Right panel — a real Google Map that fills the panel and receives pins.
 *
 * DATA:
 *   Every search runs the AEM GraphQL global query (BranchesList) which returns
 *   all locations. Results become result cards AND map pins. Address / postal
 *   code filtered queries will be introduced later and selected in `runSearch`.
 *   No business data is hardcoded here.
 *
 * MAP:
 *   Google Maps is loaded on demand from a page-supplied API key (config cell
 *   `apiKey` or page metadata `locator-maps-key`) — never hardcoded. Without a
 *   key (or if the script fails), the map shows a graceful "map unavailable"
 *   state and the search + results still work.
 *
 * INTEGRATION EVENTS: locator:ready | locator:search | locator:results.
 * All user-facing strings are data-driven via DEFAULT_CONFIG / authored rows.
 */

import { getMetadata } from '../../scripts/aem.js';
import { loadGoogleMaps, createMap } from './google-maps.js';

const DEFAULT_CONFIG = {
  heading: 'Find a Scotiabank near you',
  intro: 'Get branch & ABM hours, directions, services and more. Search by address, city or postal code to see locations near you.',
  // "Search by" categories → will drive which persisted query runs later.
  searchBy: [
    { value: 'location', label: 'Location' },
    { value: 'transit', label: 'Transit number' },
  ],
  searchByLabel: 'Search by',
  placeholder: 'Search by address, city, or postal code',
  searchInputLabel: 'Search by address, city, or postal code',
  searchLabel: 'Search',
  filtersLabel: 'Filter results',
  appointmentTitle: 'Book an appointment at a branch near you',
  appointmentCtaLabel: 'Start the conversation',
  appointmentCtaUrl: '#',
  resultsLabel: 'Results',
  resultsEmptyText: 'Search above to find Scotiabank branches, ATMs and advisors near you.',
  resultsErrorText: 'We were unable to load results. Please try again.',
  mapUnavailableText: 'Interactive map unavailable. Add a Google Maps API key to enable it.',
  detailsCtaLabel: 'View details',
  skeletonCount: 4,
  // Default map view — centred on Canada until results arrive.
  mapCenter: { lat: 56.13, lng: -106.35 },
  mapZoom: 4,
  mapId: '',
  apiKey: '',
  // AEM GraphQL persisted query. Global query → returns all branches for now.
  endpoint: 'https://publish-p130746-e1275972.adobeaemcloud.com/graphql/execute.json/Scotia/BranchesList',
};

/* ============================================================
   AEM GraphQL data source
   ============================================================ */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Parses a "09:30 AM" / "23:59" style time into minutes since midnight, or null. */
function parseTimeToMinutes(value) {
  if (!value || /closed/i.test(value)) return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3] ? match[3].toUpperCase() : null;
  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  return (hours * 60) + minutes;
}

/**
 * Derives a human-readable open/closed status for "today" from an hours object.
 * @returns {{ status: string, statusType: 'open'|'closed'|'neutral' }}
 */
function computeStatus(hours) {
  if (!hours) return { status: '', statusType: 'neutral' };
  const now = new Date();
  const day = WEEKDAYS[now.getDay()];
  const open = parseTimeToMinutes(hours[`${day}Open`]);
  const close = parseTimeToMinutes(hours[`${day}Close`]);
  if (open === null || close === null) {
    return { status: 'Closed today', statusType: 'closed' };
  }
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  const isOpen = nowMinutes >= open && nowMinutes < close;
  return isOpen
    ? { status: `Open now · until ${hours[`${day}Close`]}`, statusType: 'open' }
    : { status: `Closed · opens ${hours[`${day}Open`]}`, statusType: 'closed' };
}

/** Builds a compact weekday hours summary string from an hours object. */
function summariseHours(hours) {
  if (!hours) return '';
  const weekOpen = hours.mondayOpen;
  const weekClose = hours.mondayClose;
  const uniformWeekday = ['tuesday', 'wednesday', 'thursday', 'friday']
    .every((d) => hours[`${d}Open`] === weekOpen && hours[`${d}Close`] === weekClose);
  if (uniformWeekday && !/closed/i.test(weekOpen || 'closed')) {
    return `Mon–Fri ${weekOpen}–${weekClose}`;
  }
  return hours.title || '';
}

/**
 * Maps one branch Content Fragment item to the block's result-card model.
 * All fields optional so partial data never breaks rendering.
 */
function mapBranchToRecord(item) {
  const address = item.address || {};
  const { status, statusType } = computeStatus(item.tellerHours || item.advisorHours);
  return {
    name: item.branchName || item.transitNumber || 'Branch',
    address: address.formattedAddress?.plaintext
      || [address.streetAddress, address.city, address.province, address.postalCode].filter(Boolean).join(', '),
    hours: summariseHours(item.tellerHours),
    status,
    statusType,
    branchType: item.branchType?.title || '',
    phone: item.phoneNumber || '',
    url: item.phoneNumber ? `tel:${item.phoneNumber.replace(/[^\d+]/g, '')}` : '',
    lat: typeof address.latitude === 'number' ? address.latitude : undefined,
    lng: typeof address.longitude === 'number' ? address.longitude : undefined,
  };
}

/**
 * Runs the global GraphQL query and returns mapped branch records.
 * @param {string} endpoint persisted-query URL
 * @returns {Promise<Array<object>>}
 */
async function fetchBranches(endpoint) {
  const resp = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  const json = await resp.json();
  const items = json?.data?.branchList?.items || [];
  return items.map(mapBranchToRecord);
}

/* ============================================================
   Config & DOM helpers
   ============================================================ */

/**
 * Reads authored key/value rows + page metadata and merges over the defaults.
 * @param {Element} block
 * @returns {object} resolved config
 */
function readConfig(block) {
  const config = structuredClone(DEFAULT_CONFIG);
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = cells[0].textContent.trim().toLowerCase();
    const raw = cells[1].textContent.trim();
    if (!raw) return;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    switch (key) {
      case 'heading': config.heading = raw; break;
      case 'intro': config.intro = raw; break;
      case 'search by': config.searchBy = list.map((label) => ({ value: label.toLowerCase().replace(/\s+/g, '-'), label })); break;
      case 'placeholder': config.placeholder = raw; config.searchInputLabel = raw; break;
      case 'endpoint': config.endpoint = raw; break;
      case 'api key':
      case 'apikey': config.apiKey = raw; break;
      case 'map id':
      case 'mapid': config.mapId = raw; break;
      default: break;
    }
  });
  // Page metadata fallbacks (authorable via document metadata table).
  config.apiKey = config.apiKey || getMetadata('locator-maps-key') || '';
  config.mapId = config.mapId || getMetadata('locator-maps-id') || '';
  return config;
}

/** Create an element with attributes/classes/children. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  children.flat().forEach((c) => c && node.append(c));
  return node;
}

/* ============================================================
   UI builders
   ============================================================ */

/** Builds the search controls (search-by select + input + submit). */
function buildSearchArea(config) {
  const select = el('select', { class: 'locator-search-by', 'aria-label': config.searchByLabel, name: 'search-by' });
  config.searchBy.forEach((opt) => select.append(el('option', { value: opt.value, text: opt.label })));

  const searchByField = el('div', { class: 'locator-search-by-field' },
    el('span', { class: 'locator-field-label', text: config.searchByLabel }),
    select);

  const input = el('input', {
    class: 'locator-search-input',
    type: 'search',
    name: 'search-query',
    placeholder: config.placeholder,
    'aria-label': config.searchInputLabel,
    autocomplete: 'off',
  });

  const submit = el('button', { class: 'locator-search-submit', type: 'submit', 'aria-label': config.searchLabel },
    el('span', { class: 'locator-search-icon', 'aria-hidden': 'true' }));

  const queryField = el('div', { class: 'locator-search-query-field' },
    el('span', { class: 'locator-field-label', text: config.searchInputLabel }),
    el('div', { class: 'locator-search-input-wrap' }, input, submit));

  const form = el('form', { class: 'locator-search', role: 'search' }, searchByField, queryField);
  return { form, select, input };
}

/** Builds the "Filter results" toggle with a count badge (no filter logic yet). */
function buildFilterButton(config) {
  const count = el('span', { class: 'locator-filter-count', 'aria-live': 'polite', hidden: '' }, '0');
  const button = el('button', { class: 'locator-filter-button', type: 'button', 'aria-expanded': 'false' },
    el('span', { class: 'locator-filter-icon', 'aria-hidden': 'true' }),
    el('span', { text: config.filtersLabel }),
    count);
  // Placeholder: toggles pressed state only. Real filters arrive with GraphQL facets.
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
  });
  return { button, count };
}

/** Appointment CTA card, mirroring the reference. */
function buildAppointmentCard(config) {
  return el('div', { class: 'locator-appointment' },
    el('h2', { class: 'locator-appointment-title', text: config.appointmentTitle }),
    el('a', { class: 'button locator-appointment-cta', href: config.appointmentCtaUrl, text: config.appointmentCtaLabel }));
}

/** One skeleton (loading placeholder) result card. */
function buildSkeletonCard() {
  return el('li', { class: 'locator-card locator-card-skeleton', 'aria-hidden': 'true' },
    el('div', { class: 'locator-card-body' },
      el('span', { class: 'locator-skeleton locator-skeleton-title' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line short' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line' })));
}

/** A real result card from a data record. */
function buildResultCard(record, config) {
  const {
    name, address, hours, status, statusType, url,
  } = record;
  const parts = [];
  if (name) parts.push(el('h3', { class: 'locator-card-name', text: name }));
  if (status) {
    parts.push(el('p', { class: 'locator-card-status', 'data-status': statusType || 'neutral' },
      el('span', { class: 'locator-card-status-dot', 'aria-hidden': 'true' }),
      el('span', { text: status })));
  }
  if (address) parts.push(el('p', { class: 'locator-card-address', text: address }));
  if (hours) parts.push(el('p', { class: 'locator-card-hours', text: hours }));
  if (url) parts.push(el('a', { class: 'locator-card-cta', href: url, text: config.detailsCtaLabel }));
  return el('li', { class: 'locator-card' }, el('div', { class: 'locator-card-body' }, ...parts));
}

/** Results panel (count + scrollable region + empty/error states). */
function buildResultsArea(config) {
  const count = el('p', { class: 'locator-results-count', 'aria-live': 'polite', hidden: '' },
    el('span', { class: 'locator-results-count-value', text: '0' }), ' ', el('span', { text: config.resultsLabel }));
  const list = el('ul', { class: 'locator-results-list', 'aria-busy': 'false' });
  const empty = el('div', { class: 'locator-results-empty' }, el('p', { text: config.resultsEmptyText }));
  const error = el('div', { class: 'locator-results-error', hidden: '' }, el('p', { text: config.resultsErrorText }));
  const region = el('div', { class: 'locator-results-scroll', role: 'region', 'aria-label': config.resultsLabel }, list, empty, error);
  const area = el('div', { class: 'locator-results' }, count, region);
  return {
    area, count, list, empty, error,
  };
}

/** Map panel: the Google Map render target + loading/unavailable overlays. */
function buildMapArea(config) {
  const canvas = el('div', { class: 'locator-map-canvas', role: 'application', 'aria-label': 'Map' });
  const loading = el('div', { class: 'locator-map-loading' },
    el('span', { class: 'locator-map-spinner', 'aria-hidden': 'true' }), el('span', { text: 'Loading map…' }));
  const unavailable = el('div', { class: 'locator-map-unavailable', hidden: '' },
    el('span', { class: 'locator-map-pin-icon', 'aria-hidden': 'true' }),
    el('p', { text: config.mapUnavailableText }));
  const shell = el('div', {
    class: 'locator-map', 'data-map-state': 'loading',
  }, canvas, loading, unavailable);
  return {
    area: shell, shell, canvas, loading, unavailable,
  };
}

/* ============================================================
   Public API (data-source seam)
   ============================================================ */

function createLocatorApi(block, refs, config, mapController) {
  const {
    resultsCount, resultsCountEl, resultsList, resultsEmpty, resultsError, mapShell,
  } = refs;

  const clearStates = () => { resultsEmpty.hidden = true; resultsError.hidden = true; };

  return {
    config,

    setLoading(isLoading) {
      resultsList.setAttribute('aria-busy', String(!!isLoading));
      if (isLoading) {
        clearStates();
        resultsCountEl.hidden = true;
        resultsList.replaceChildren();
        for (let i = 0; i < config.skeletonCount; i += 1) resultsList.append(buildSkeletonCard());
      }
    },

    setResults(records = []) {
      clearStates();
      resultsList.setAttribute('aria-busy', 'false');
      resultsList.replaceChildren();
      if (!records.length) { this.showEmpty(); return; }
      records.forEach((r) => resultsList.append(buildResultCard(r, config)));
      resultsCount.textContent = String(records.length);
      resultsCountEl.hidden = false;
    },

    /**
     * Plot markers on the real Google Map (when available). Points carry
     * lat/lng and an optional info-window content string.
     */
    setMarkers(records = []) {
      const points = records
        .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
        .map((r) => ({
          lat: r.lat,
          lng: r.lng,
          title: r.name,
          content: `<strong>${r.name}</strong><br>${r.address || ''}`,
        }));
      if (mapController) {
        mapController.setMarkers(points);
        mapShell.setAttribute('data-map-state', 'ready');
      }
    },

    showEmpty() {
      resultsList.replaceChildren();
      resultsList.setAttribute('aria-busy', 'false');
      resultsError.hidden = true;
      resultsEmpty.hidden = false;
      resultsCountEl.hidden = true;
    },

    setError() {
      resultsList.replaceChildren();
      resultsList.setAttribute('aria-busy', 'false');
      resultsEmpty.hidden = true;
      resultsError.hidden = false;
      resultsCountEl.hidden = true;
    },
  };
}

/* ============================================================
   Decorate
   ============================================================ */

export default async function decorate(block) {
  const config = readConfig(block);
  block.replaceChildren();

  // Left panel
  const intro = el('div', { class: 'locator-intro' },
    el('h1', { class: 'locator-heading', text: config.heading }),
    el('p', { class: 'locator-lede', text: config.intro }));
  const { form, select, input } = buildSearchArea(config);
  const { button: filterButton } = buildFilterButton(config);
  const appointment = buildAppointmentCard(config);
  const {
    area: resultsArea, count: resultsCountEl, list: resultsList, empty: resultsEmpty, error: resultsError,
  } = buildResultsArea(config);
  const resultsCount = resultsCountEl.querySelector('.locator-results-count-value');

  const leftPanel = el('div', { class: 'locator-panel locator-panel-left' },
    intro, form, filterButton, appointment, resultsArea);

  // Right panel (map)
  const {
    area: mapArea, shell: mapShell, canvas: mapCanvas, loading: mapLoading, unavailable: mapUnavailable,
  } = buildMapArea(config);
  const rightPanel = el('div', { class: 'locator-panel locator-panel-right' }, mapArea);

  block.append(leftPanel, rightPanel);

  // Initialise the Google Map (graceful fallback when no key / load failure).
  let mapController = null;
  try {
    const maps = await loadGoogleMaps(config.apiKey);
    mapController = createMap(maps, mapCanvas, {
      center: config.mapCenter, zoom: config.mapZoom, mapId: config.mapId,
    });
    mapLoading.hidden = true;
    mapShell.setAttribute('data-map-state', 'ready');
  } catch (err) {
    mapLoading.hidden = true;
    mapUnavailable.hidden = false;
    mapShell.setAttribute('data-map-state', 'unavailable');
    // eslint-disable-next-line no-console
    console.warn('[locator] Google Maps unavailable —', err.message);
  }

  const api = createLocatorApi(block, {
    resultsCount, resultsCountEl, resultsList, resultsEmpty, resultsError, mapShell,
  }, config, mapController);
  block.locator = api;

  /**
   * Runs a search. For now every search runs the global BranchesList query
   * (returns all branches); filtered queries will be selected here later.
   */
  const runSearch = async (detail) => {
    api.setLoading(true);
    block.dispatchEvent(new CustomEvent('locator:search', { detail, bubbles: true }));
    try {
      const records = await fetchBranches(config.endpoint);
      api.setResults(records);
      api.setMarkers(records);
      block.dispatchEvent(new CustomEvent('locator:results', { detail: { records }, bubbles: true }));
    } catch (err) {
      api.setError();
      // eslint-disable-next-line no-console
      console.error('[locator] search failed', err);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch({ searchBy: select.value, query: input.value.trim(), filters: {} });
  });

  // Initial state: prompt to search; map is populated only after a search.
  api.showEmpty();

  requestAnimationFrame(() => {
    block.dispatchEvent(new CustomEvent('locator:ready', { detail: api, bubbles: true }));
  });
}
