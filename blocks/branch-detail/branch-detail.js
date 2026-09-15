/*
 * Branch detail block — a single, query-param-driven page that builds itself
 * from a branch ID, so one page serves every branch (no page-per-branch).
 *
 * URL contract:  /branch-details?id=<transitNumber>   (e.g. ?id=83220)
 * Data:          AEM GraphQL  BranchByTransit;transitNumber=<id>  (one branch).
 *
 * The map reuses the locator block's on-demand Google Maps loader. The key is
 * read from page metadata (locator-maps-key), same as the locator, so both
 * blocks share one configured key.
 */

import { getMetadata } from '../../scripts/aem.js';
import { loadGoogleMaps, createMap } from '../locator/google-maps.js';

const DEFAULT_CONFIG = {
  endpoint: 'https://publish-p130746-e1275972.adobeaemcloud.com/graphql/execute.json/Scotia/BranchByTransit;transitNumber=',
  idParam: 'id',
  backLabel: 'Back to Branch Locator',
  backUrl: '/branch-locator',
  loadingText: 'Loading branch details…',
  notFoundText: 'We couldn’t find that branch. It may have moved or the link is out of date.',
  errorText: 'We were unable to load this branch. Please try again.',
  mapUnavailableText: 'Interactive map unavailable.',
  // Section labels (data-driven for localization).
  labels: {
    tellerHours: 'Branch hours',
    advisorHours: 'Advisor hours',
    abmHours: 'ABM hours',
    services: 'Services',
    languages: 'Languages',
    branchType: 'Branch type',
    phone: 'Phone',
    getDirections: 'Get directions',
  },
  mapZoom: 15,
  mapId: '',
  apiKey: '',
};

/* ============================================================
   Hours / status helpers (self-contained; mirror the locator block)
   ============================================================ */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Display order Monday→Sunday (index into WEEKDAYS / DAY_LABELS_FULL).
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function isClosedDay(open, close) {
  if (!open || !close) return true;
  return /closed/i.test(open) || /closed/i.test(close);
}

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

/** Open/closed status for today from an hours object. */
function computeStatus(hours) {
  if (!hours) return null;
  const now = new Date();
  const day = WEEKDAYS[now.getDay()];
  const open = parseTimeToMinutes(hours[`${day}Open`]);
  const close = parseTimeToMinutes(hours[`${day}Close`]);
  if (open === null || close === null) return { status: 'Closed today', statusType: 'closed' };
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  const closeLabel = hours[`${day}Close`];
  const openLabel = hours[`${day}Open`];
  return (nowMinutes >= open && nowMinutes < close)
    ? { status: `Open now · until ${closeLabel}`, statusType: 'open' }
    : { status: `Closed · opens ${openLabel}`, statusType: 'closed' };
}

/* ============================================================
   DOM helper
   ============================================================ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  children.flat().forEach((c) => c && node.append(c));
  return node;
}

/* ============================================================
   Data
   ============================================================ */

/** Fetches one branch by transit number; cache-busted for the demo env. */
async function fetchBranch(endpoint, id) {
  // Cache-buster MUST be a `?` query string, not `&` — the persisted-query URL
  // uses the `;name=value` suffix grammar, where a trailing `&ck=` would merge
  // into the transitNumber value (…=83220&ck=…) and match no branch.
  const url = `${endpoint}${encodeURIComponent(id)}?ck=${Date.now()}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  const json = await resp.json();
  const items = json?.data?.branchList?.items || [];
  return items[0] || null;
}

/* ============================================================
   Config
   ============================================================ */

function readConfig(block) {
  const config = structuredClone(DEFAULT_CONFIG);
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = cells[0].textContent.trim().toLowerCase();
    const raw = cells[1].textContent.trim();
    if (!raw) return;
    switch (key) {
      case 'endpoint': config.endpoint = raw; break;
      case 'id param': case 'idparam': config.idParam = raw; break;
      case 'back label': config.backLabel = raw; break;
      case 'back url': config.backUrl = raw; break;
      case 'api key': case 'apikey': config.apiKey = raw; break;
      case 'map id': case 'mapid': config.mapId = raw; break;
      default: break;
    }
  });
  config.apiKey = config.apiKey || getMetadata('locator-maps-key') || '';
  config.mapId = config.mapId || getMetadata('locator-maps-id') || '';
  return config;
}

/* ============================================================
   Renderers
   ============================================================ */

/** A definition-list-style hours table for one hours set. Returns null if all closed. */
function buildHoursTable(hours) {
  if (!hours) return null;
  const rows = DISPLAY_ORDER.map((idx) => {
    const day = WEEKDAYS[idx];
    const open = hours[`${day}Open`];
    const close = hours[`${day}Close`];
    const closed = isClosedDay(open, close);
    const isToday = idx === new Date().getDay();
    return el('div', { class: 'branch-detail-hours-row', 'data-today': isToday ? 'true' : 'false' },
      el('span', { class: 'branch-detail-hours-day', text: DAY_LABELS_FULL[idx] }),
      el('span', { class: 'branch-detail-hours-time', text: closed ? 'Closed' : `${open}–${close}` }));
  });
  // If every day is closed, treat as "no hours" (skip the whole set).
  const anyOpen = DISPLAY_ORDER.some((idx) => !isClosedDay(hours[`${WEEKDAYS[idx]}Open`], hours[`${WEEKDAYS[idx]}Close`]));
  if (!anyOpen) return null;
  return el('div', { class: 'branch-detail-hours' }, ...rows);
}

/** Builds one labelled hours card (skipped when the set has no open days). */
function buildHoursSection(label, hours) {
  const table = buildHoursTable(hours);
  if (!table) return null;
  return el('section', { class: 'branch-detail-section branch-detail-hours-section' },
    el('h2', { class: 'branch-detail-section-title', text: label }),
    table);
}

/** Chip list (services / languages). */
function buildChips(label, values) {
  if (!values || !values.length) return null;
  return el('section', { class: 'branch-detail-section' },
    el('h2', { class: 'branch-detail-section-title', text: label }),
    el('ul', { class: 'branch-detail-chips' },
      ...values.map((v) => el('li', { class: 'branch-detail-chip', text: v }))));
}

/** Builds the full branch detail DOM from a record + config. */
function renderBranch(branch, config, mapCanvas) {
  const { labels } = config;
  const address = branch.address || {};
  const addressText = address.formattedAddress?.plaintext
    || [address.streetAddress, address.city, address.province, address.postalCode].filter(Boolean).join(', ');
  const status = computeStatus(branch.tellerHours || branch.advisorHours);
  const phone = branch.phoneNumber || '';
  const telHref = phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : '';
  const hasGeo = typeof address.latitude === 'number' && typeof address.longitude === 'number';
  const directionsHref = hasGeo
    ? `https://www.google.com/maps/dir/?api=1&destination=${address.latitude},${address.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`;

  // Header: name, status, branch type
  const header = el('header', { class: 'branch-detail-header' },
    el('a', { class: 'branch-detail-back', href: config.backUrl, text: `‹ ${config.backLabel}` }),
    el('h1', { class: 'branch-detail-name', text: branch.branchName || branch.transitNumber || 'Branch' }),
    status ? el('p', { class: 'branch-detail-status', 'data-status': status.statusType },
      el('span', { class: 'branch-detail-status-dot', 'aria-hidden': 'true' }),
      el('span', { text: status.status })) : null,
    branch.branchType?.title
      ? el('p', { class: 'branch-detail-type', text: branch.branchType.title }) : null);

  // Contact / at-a-glance column
  const contact = el('div', { class: 'branch-detail-contact' },
    el('section', { class: 'branch-detail-section' },
      el('h2', { class: 'branch-detail-section-title', text: 'Address' }),
      el('p', { class: 'branch-detail-address', text: addressText }),
      el('a', { class: 'button branch-detail-directions', href: directionsHref, target: '_blank', rel: 'noopener', text: labels.getDirections })),
    phone ? el('section', { class: 'branch-detail-section' },
      el('h2', { class: 'branch-detail-section-title', text: labels.phone }),
      el('a', { class: 'branch-detail-phone', href: telHref, text: phone })) : null,
    buildChips(labels.services, (branch.features || []).map((f) => f.title).filter(Boolean)),
    buildChips(labels.languages, (branch.languages || []).map((l) => l.title).filter(Boolean)));

  // Hours column (teller / advisor / ABM)
  const hoursCol = el('div', { class: 'branch-detail-hours-col' },
    buildHoursSection(labels.tellerHours, branch.tellerHours),
    buildHoursSection(labels.advisorHours, branch.advisorHours),
    buildHoursSection(labels.abmHours, branch.abmHours));

  const body = el('div', { class: 'branch-detail-body' },
    el('div', { class: 'branch-detail-info' }, contact, hoursCol),
    el('div', { class: 'branch-detail-map' }, mapCanvas));

  return {
    root: el('div', { class: 'branch-detail-inner' }, header, body),
    hasGeo,
    center: hasGeo ? { lat: address.latitude, lng: address.longitude } : null,
    label: branch.branchName || '',
  };
}

/* ============================================================
   Decorate
   ============================================================ */

export default async function decorate(block) {
  const config = readConfig(block);
  block.replaceChildren();

  const id = new URLSearchParams(window.location.search).get(config.idParam);

  // No id → prompt back to the locator.
  if (!id) {
    block.append(el('div', { class: 'branch-detail-inner' },
      el('div', { class: 'branch-detail-message' },
        el('p', { text: config.notFoundText }),
        el('a', { class: 'button', href: config.backUrl, text: config.backLabel }))));
    return;
  }

  // Loading state
  const loading = el('div', { class: 'branch-detail-loading' },
    el('span', { class: 'branch-detail-spinner', 'aria-hidden': 'true' }),
    el('span', { text: config.loadingText }));
  block.append(loading);

  let branch;
  try {
    branch = await fetchBranch(config.endpoint, id);
  } catch (err) {
    block.replaceChildren(el('div', { class: 'branch-detail-inner' },
      el('div', { class: 'branch-detail-message' }, el('p', { text: config.errorText }),
        el('a', { class: 'button', href: config.backUrl, text: config.backLabel }))));
    // eslint-disable-next-line no-console
    console.error('[branch-detail] fetch failed', err);
    return;
  }

  if (!branch) {
    block.replaceChildren(el('div', { class: 'branch-detail-inner' },
      el('div', { class: 'branch-detail-message' }, el('p', { text: config.notFoundText }),
        el('a', { class: 'button', href: config.backUrl, text: config.backLabel }))));
    return;
  }

  // Update the document title for a per-branch feel (SEO/UX; content-safe).
  if (branch.branchName) document.title = `${branch.branchName} | Scotiabank`;

  const mapCanvas = el('div', { class: 'branch-detail-map-canvas', role: 'application', 'aria-label': 'Map' });
  const mapUnavailable = el('div', { class: 'branch-detail-map-unavailable', hidden: '' },
    el('span', { class: 'branch-detail-map-pin', 'aria-hidden': 'true' }),
    el('p', { text: config.mapUnavailableText }));
  const mapWrap = el('div', { class: 'branch-detail-map-wrap' }, mapCanvas, mapUnavailable);

  const { root, hasGeo, center } = renderBranch(branch, config, mapWrap);
  block.replaceChildren(root);

  // Initialise the map (graceful fallback). Only when the branch has coords.
  if (hasGeo) {
    try {
      const maps = await loadGoogleMaps(config.apiKey);
      const controller = createMap(maps, mapCanvas, { center, zoom: config.mapZoom, mapId: config.mapId });
      controller.setMarkers([{
        lat: center.lat,
        lng: center.lng,
        title: branch.branchName,
      }]);
    } catch (err) {
      mapUnavailable.hidden = false;
      mapUnavailable.style.display = 'flex';
      // eslint-disable-next-line no-console
      console.warn('[branch-detail] map unavailable —', err.message);
    }
  } else {
    mapUnavailable.hidden = false;
    mapUnavailable.style.display = 'flex';
  }

  block.dispatchEvent(new CustomEvent('branch-detail:ready', { detail: { branch }, bubbles: true }));
}
