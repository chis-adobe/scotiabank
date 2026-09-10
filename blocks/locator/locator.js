/*
 * Locator block — presentation layer for a headless branch / ATM / advisor finder.
 *
 * ARCHITECTURE
 * ------------
 * This block renders ONLY the presentation layer. It contains NO business data.
 * All records (branches, ATMs, advisors, hours, addresses, branch types) are
 * expected to originate from AEM Content Fragments exposed through GraphQL and
 * to be supplied at runtime via the public API below.
 *
 * Integration points (see `createLocatorApi` for the full contract):
 *   - `locator:ready`  — fired once the DOM is built; detail is the public API.
 *   - `locator:search` — fired when the user submits a search; detail carries
 *                        { searchBy, query, filters }. A GraphQL client listens
 *                        for this, runs a persisted query, and calls the API to
 *                        render results and markers.
 *   - api.setLoading / setResults / setFilterOptions / setMarkers / setError /
 *     showEmpty — the surface a GraphQL data source drives.
 *
 * Until a data source connects, the block shows skeleton result cards and an
 * empty map canvas — i.e. it visibly "waits for AEM GraphQL data".
 *
 * All user-facing strings are data-driven: defaults live in DEFAULT_CONFIG and
 * are overridable per-instance via the block's authored rows (localization).
 */

const DEFAULT_CONFIG = {
  // Search "search by" categories → drive which Content Fragment model / query is used later.
  searchBy: [
    { value: 'location', label: 'Location' },
    { value: 'branch', label: 'Branch' },
    { value: 'advisor', label: 'Advisor' },
    { value: 'atm', label: 'ATM' },
  ],
  placeholder: 'Search by address, city, postal code or keyword',
  searchLabel: 'Search',
  searchByLabel: 'Search by',
  filtersLabel: 'Filters',
  filtersHint: 'Refine your results',
  // Placeholder filter groups. Real options will be populated from GraphQL
  // (branch types, services, accessibility features, hours).
  filters: [
    { key: 'branchType', label: 'Branch Type' },
    { key: 'services', label: 'Services Available' },
    { key: 'accessibility', label: 'Accessibility' },
    { key: 'hours', label: 'Hours' },
  ],
  resultsLabel: 'Results',
  resultsLoadingText: 'Searching…',
  resultsEmptyText: 'Enter a location above to find branches, ATMs and advisors near you.',
  resultsErrorText: 'We were unable to load results. Please try again.',
  mapLoadingText: 'Loading map…',
  mapEmptyText: 'Search results will appear on the map.',
  detailsCtaLabel: 'View details',
  // Number of skeleton cards to show while waiting for a data source.
  skeletonCount: 4,
  // AEM GraphQL persisted query. For now every search runs this global query,
  // which returns all branches. Address / postal-code filtered queries will be
  // introduced later and swapped in here (or selected per searchBy value).
  endpoint: 'https://publish-p130746-e1275972.adobeaemcloud.com/graphql/execute.json/Scotia/BranchesList',
};

/* ============================================================
   AEM GraphQL data source
   Maps Content Fragment records → the block's presentation model.
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
  const closeLabel = hours[`${day}Close`];
  const openLabel = hours[`${day}Open`];
  return isOpen
    ? { status: `Open now · until ${closeLabel}`, statusType: 'open' }
    : { status: `Closed · opens ${openLabel}`, statusType: 'closed' };
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
 * All fields are optional so partial data never breaks rendering.
 */
function mapBranchToRecord(item) {
  const address = item.address || {};
  const { status, statusType } = computeStatus(item.tellerHours || item.advisorHours);
  return {
    name: item.branchName || item.transitNumber || 'Branch',
    address: address.formattedAddress?.plaintext || [address.streetAddress, address.city, address.province, address.postalCode].filter(Boolean).join(', '),
    hours: summariseHours(item.tellerHours),
    status,
    statusType,
    branchType: item.branchType?.title || '',
    url: item.phoneNumber ? `tel:${item.phoneNumber.replace(/[^\d+]/g, '')}` : '#',
    lat: address.latitude,
    lng: address.longitude,
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

/**
 * Projects branch lat/lng onto normalized 0–100% canvas positions so the
 * placeholder map can plot pins without a mapping provider. A single point
 * (or missing coords) is centred.
 * @param {Array<object>} records
 * @returns {Array<{ x:number, y:number, label:string }>}
 */
function computeMarkerPositions(records) {
  const geo = records.filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number');
  if (!geo.length) return [];
  const lats = geo.map((r) => r.lat);
  const lngs = geo.map((r) => r.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;
  // Inset by 15% so pins never hug the canvas edges.
  const project = (v, min, span) => 15 + (((v - min) / span) * 70);
  return geo.map((r) => ({
    // longitude → x (east is right), latitude → y (north is up, so invert)
    x: geo.length === 1 ? 50 : project(r.lng, minLng, spanLng),
    y: geo.length === 1 ? 50 : (100 - project(r.lat, minLat, spanLat)),
    label: r.name,
  }));
}

/**
 * Reads authored key/value rows from the block and merges them over the
 * defaults. Each row is [label, value]; comma-separated values become lists.
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
      case 'search by':
        config.searchBy = list.map((label) => ({ value: label.toLowerCase(), label }));
        break;
      case 'placeholder':
        config.placeholder = raw;
        break;
      case 'filters':
        config.filters = list.map((label) => ({ key: label.toLowerCase().replace(/\s+/g, '-'), label }));
        break;
      case 'endpoint':
        config.endpoint = raw;
        break;
      default:
        // ignore unknown keys — forward-compatible with future config rows
        break;
    }
  });
  return config;
}

/** Small helper: create an element with attributes/classes/children. */
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

/** Builds the search controls (search-by select + input + submit). */
function buildSearchArea(config) {
  const select = el('select', {
    class: 'locator-search-by',
    'aria-label': config.searchByLabel,
    name: 'search-by',
  });
  config.searchBy.forEach((opt) => select.append(el('option', { value: opt.value, text: opt.label })));

  const input = el('input', {
    class: 'locator-search-input',
    type: 'search',
    name: 'search-query',
    placeholder: config.placeholder,
    'aria-label': config.placeholder,
    autocomplete: 'off',
  });

  const submit = el('button', {
    class: 'locator-search-submit',
    type: 'submit',
    'aria-label': config.searchLabel,
  }, el('span', { class: 'locator-search-icon', 'aria-hidden': 'true' }), el('span', { class: 'locator-search-submit-label', text: config.searchLabel }));

  const form = el('form', { class: 'locator-search', role: 'search' },
    el('div', { class: 'locator-search-field' }, select),
    el('div', { class: 'locator-search-field locator-search-field-query' }, input, submit));

  return { form, select, input };
}

/** Builds the collapsible filter area with a live filter-count badge. */
function buildFilterArea(config) {
  const count = el('span', { class: 'locator-filter-count', 'aria-live': 'polite' }, '0');
  const toggle = el('button', {
    class: 'locator-filter-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'locator-filter-panel',
  }, el('span', { class: 'locator-filter-toggle-label', text: config.filtersLabel }), count);

  const groups = config.filters.map((f) => el('div', { class: 'locator-filter-group', 'data-filter': f.key },
    el('button', {
      class: 'locator-filter-group-toggle',
      type: 'button',
      'aria-expanded': 'false',
    }, el('span', { text: f.label })),
    // Options list is a documented integration point — populated from GraphQL.
    el('ul', { class: 'locator-filter-options', 'data-empty': 'true' },
      el('li', { class: 'locator-filter-placeholder', text: '—' }))));

  const panel = el('div', {
    class: 'locator-filter-panel',
    id: 'locator-filter-panel',
    hidden: 'until-found',
  }, el('p', { class: 'locator-filter-hint', text: config.filtersHint }), ...groups);

  const area = el('div', { class: 'locator-filters' }, toggle, panel);

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    panel.hidden = open;
  });

  groups.forEach((group) => {
    const gToggle = group.querySelector('.locator-filter-group-toggle');
    gToggle.addEventListener('click', () => {
      const open = gToggle.getAttribute('aria-expanded') === 'true';
      gToggle.setAttribute('aria-expanded', String(!open));
    });
  });

  return { area, count };
}

/** Builds one skeleton (loading placeholder) result card. */
function buildSkeletonCard() {
  return el('li', { class: 'locator-card locator-card-skeleton', 'aria-hidden': 'true' },
    el('div', { class: 'locator-card-body' },
      el('span', { class: 'locator-skeleton locator-skeleton-title' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line short' }),
      el('span', { class: 'locator-skeleton locator-skeleton-line' }),
      el('span', { class: 'locator-skeleton locator-skeleton-cta' })));
}

/**
 * Builds a real result card from a data record. Called by the public API once
 * GraphQL data arrives. The record shape mirrors the expected Content Fragment
 * model fields — all optional so partial data never breaks rendering.
 * @param {object} record { name, address, hours, status, statusType, url }
 * @param {object} config
 */
function buildResultCard(record, config) {
  const {
    name, address, hours, status, statusType, url,
  } = record;
  const parts = [];
  if (name) parts.push(el('h3', { class: 'locator-card-name', text: name }));
  if (status) {
    parts.push(el('p', {
      class: 'locator-card-status',
      'data-status': statusType || 'neutral',
    }, el('span', { class: 'locator-card-status-dot', 'aria-hidden': 'true' }), el('span', { text: status })));
  }
  if (address) parts.push(el('p', { class: 'locator-card-address', text: address }));
  if (hours) parts.push(el('p', { class: 'locator-card-hours', text: hours }));
  if (url || config.detailsCtaLabel) {
    parts.push(el('a', {
      class: 'locator-card-cta',
      href: url || '#',
      text: config.detailsCtaLabel,
    }));
  }
  return el('li', { class: 'locator-card' }, el('div', { class: 'locator-card-body' }, ...parts));
}

/** Builds the results panel (count + scrollable region + states). */
function buildResultsArea(config) {
  const count = el('p', { class: 'locator-results-count', 'aria-live': 'polite' },
    el('span', { class: 'locator-results-count-value', text: '0' }),
    ' ',
    el('span', { text: config.resultsLabel }));

  const list = el('ul', { class: 'locator-results-list', 'aria-busy': 'true' });
  // Default state: skeleton cards signalling "waiting for GraphQL data".
  for (let i = 0; i < config.skeletonCount; i += 1) list.append(buildSkeletonCard());

  const empty = el('div', { class: 'locator-results-empty', hidden: '' }, el('p', { text: config.resultsEmptyText }));
  const error = el('div', { class: 'locator-results-error', hidden: '' }, el('p', { text: config.resultsErrorText }));

  const region = el('div', { class: 'locator-results-scroll', tabindex: '0', role: 'region', 'aria-label': config.resultsLabel }, list, empty, error);
  const area = el('div', { class: 'locator-results' }, count, region);

  return {
    area, count, list, empty, error,
  };
}

/** Builds the map canvas with loading / empty states and placeholder markers. */
function buildMapArea(config) {
  const loading = el('div', { class: 'locator-map-loading' },
    el('span', { class: 'locator-map-spinner', 'aria-hidden': 'true' }),
    el('span', { text: config.mapLoadingText }));

  const empty = el('div', { class: 'locator-map-empty', hidden: '' }, el('p', { text: config.mapEmptyText }));

  // Decorative placeholder markers — the future map provider renders real pins.
  const markers = el('div', { class: 'locator-map-markers', 'aria-hidden': 'true' });
  for (let i = 0; i < 3; i += 1) markers.append(el('span', { class: 'locator-map-marker' }));

  // Empty render target for the future mapping library (no provider integrated).
  const canvas = el('div', {
    class: 'locator-map-canvas',
    'data-map-state': 'loading',
    role: 'application',
    'aria-label': 'Map',
  }, markers, loading, empty);

  const area = el('div', { class: 'locator-map' }, canvas);
  return {
    area, canvas, loading, empty, markers,
  };
}

/**
 * Creates the public API that a GraphQL data source uses to drive the block.
 * This is the seam between the presentation layer (this block) and the data
 * layer (a future GraphQL client fed by AEM Content Fragments).
 */
function createLocatorApi(block, refs, config) {
  const {
    resultsCount, resultsList, resultsEmpty, resultsError, mapCanvas, mapMarkers, filterCount,
  } = refs;

  const clearStates = () => {
    resultsEmpty.hidden = true;
    resultsError.hidden = true;
  };

  const api = {
    /** Config resolved from content — exposes labels/endpoint to the data source. */
    config,

    /** Toggle the loading (skeleton) state. */
    setLoading(isLoading) {
      resultsList.setAttribute('aria-busy', String(!!isLoading));
      mapCanvas.setAttribute('data-map-state', isLoading ? 'loading' : 'ready');
      if (isLoading) {
        clearStates();
        resultsList.replaceChildren();
        for (let i = 0; i < config.skeletonCount; i += 1) resultsList.append(buildSkeletonCard());
      }
    },

    /**
     * Render result cards from GraphQL records.
     * @param {Array<object>} records
     */
    setResults(records = []) {
      clearStates();
      resultsList.setAttribute('aria-busy', 'false');
      resultsList.replaceChildren();
      if (!records.length) {
        this.showEmpty();
        resultsCount.textContent = '0';
        return;
      }
      records.forEach((r) => resultsList.append(buildResultCard(r, config)));
      resultsCount.textContent = String(records.length);
      mapCanvas.setAttribute('data-map-state', 'ready');
    },

    /**
     * Populate filter options for a group.
     * @param {string} key filter group key
     * @param {Array<{value:string,label:string}>} options
     */
    setFilterOptions(key, options = []) {
      const group = block.querySelector(`.locator-filter-group[data-filter="${CSS.escape(key)}"]`);
      if (!group) return;
      const ul = group.querySelector('.locator-filter-options');
      ul.dataset.empty = options.length ? 'false' : 'true';
      ul.replaceChildren(...options.map((o) => el('li', { class: 'locator-filter-option' },
        el('label', {},
          el('input', { type: 'checkbox', value: o.value, name: key }),
          el('span', { text: o.label })))));
    },

    /** Update the active filter count badge. */
    setFilterCount(n) {
      filterCount.textContent = String(n || 0);
      filterCount.classList.toggle('has-count', !!n);
    },

    /**
     * Plot markers on the placeholder map. Each point may carry `x`/`y`
     * (0–100% canvas position, as produced by computeMarkerPositions) so pins
     * land in geographically-relative spots; without them pins are hidden
     * behind the default decorative layout.
     * @param {Array<{x?:number,y?:number,label?:string}>} points
     */
    setMarkers(points = []) {
      mapMarkers.replaceChildren();
      mapMarkers.dataset.count = String(points.length);
      points.forEach((p) => {
        const marker = el('span', { class: 'locator-map-marker', 'data-active': 'true' });
        if (p && typeof p.label === 'string') marker.title = p.label;
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          marker.style.left = `${p.x}%`;
          marker.style.top = `${p.y}%`;
        }
        mapMarkers.append(marker);
      });
      mapCanvas.setAttribute('data-map-state', points.length ? 'ready' : 'empty');
    },

    /** Show the empty state (no results / initial). */
    showEmpty() {
      resultsList.replaceChildren();
      resultsList.setAttribute('aria-busy', 'false');
      resultsError.hidden = true;
      resultsEmpty.hidden = false;
      mapCanvas.setAttribute('data-map-state', 'empty');
    },

    /** Show the error state. */
    setError() {
      resultsList.replaceChildren();
      resultsList.setAttribute('aria-busy', 'false');
      resultsEmpty.hidden = true;
      resultsError.hidden = false;
    },
  };

  return api;
}

/**
 * loads and decorates the locator block
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const config = readConfig(block);

  // Rebuild the block from the resolved config.
  block.replaceChildren();

  const { form, select, input } = buildSearchArea(config);
  const { area: filterArea, count: filterCount } = buildFilterArea(config);
  const {
    area: resultsArea, count: resultsCountEl, list: resultsList, empty: resultsEmpty, error: resultsError,
  } = buildResultsArea(config);
  const {
    area: mapArea, canvas: mapCanvas, empty: mapEmpty, markers: mapMarkers,
  } = buildMapArea(config);

  const resultsCount = resultsCountEl.querySelector('.locator-results-count-value');

  const leftPanel = el('div', { class: 'locator-panel locator-panel-left' }, form, filterArea, resultsArea);
  const rightPanel = el('div', { class: 'locator-panel locator-panel-right' }, mapArea);

  block.append(leftPanel, rightPanel);

  // Public API for the future GraphQL data source.
  const api = createLocatorApi(block, {
    resultsCount, resultsList, resultsEmpty, resultsError, mapCanvas, mapMarkers, filterCount,
  }, config);
  block.locator = api;

  /**
   * Runs a search against the GraphQL data source and drives the block.
   * For now every search runs the global BranchesList query (returns all
   * branches). Address / postal-code filtered queries will be introduced later
   * and selected here based on `detail.searchBy` / `detail.query`.
   */
  const runSearch = async (detail) => {
    // Presentation feedback: show the searching/skeleton state immediately.
    mapEmpty.hidden = true;
    api.setLoading(true);
    block.dispatchEvent(new CustomEvent('locator:search', { detail, bubbles: true }));
    try {
      const records = await fetchBranches(config.endpoint);
      api.setResults(records);
      api.setMarkers(computeMarkerPositions(records));
      block.dispatchEvent(new CustomEvent('locator:results', { detail: { records }, bubbles: true }));
    } catch (err) {
      // Fail securely: show the error state, never leak internals to the user.
      api.setError();
      // eslint-disable-next-line no-console
      console.error('[locator] search failed', err);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch({
      searchBy: select.value,
      query: input.value.trim(),
      filters: {},
    });
  });

  // Initial state: empty map + prompt. The map is only populated after a search.
  api.showEmpty();
  mapEmpty.hidden = false;

  // Announce readiness so external code can connect and drive the block.
  requestAnimationFrame(() => {
    block.dispatchEvent(new CustomEvent('locator:ready', { detail: api, bubbles: true }));
  });
}
