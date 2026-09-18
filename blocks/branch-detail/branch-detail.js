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
  // Contact request form (data-driven for localization).
  form: {
    title: 'Contact request',
    nameLabel: 'Name',
    productLabel: 'Product of interest',
    addressLabel: 'Address',
    addressPlaceholder: 'Start typing your address…',
    messageLabel: 'Message',
    submitLabel: 'Send request',
    successText: 'Thanks — your request has been received. A representative will be in touch.',
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

/**
 * Builds a tabbed hours component (Teller Service / Advisor / ABM), mirroring
 * the reference detail page. Only sets that have open days become tabs.
 * @param {Array<{label:string, hours:object}>} sets
 */
function buildHoursTabs(sets) {
  const panels = sets
    .map((s) => ({ label: s.label, table: buildHoursTable(s.hours) }))
    .filter((s) => s.table);
  if (!panels.length) return null;

  const tablist = el('div', { class: 'branch-detail-tabs-list', role: 'tablist', 'aria-label': 'Branch hours' });
  const panelWrap = el('div', { class: 'branch-detail-tabs-panels' });

  panels.forEach((p, i) => {
    const id = `hours-tab-${i}`;
    const panelId = `hours-panel-${i}`;
    const tab = el('button', {
      class: 'branch-detail-tab',
      type: 'button',
      role: 'tab',
      id,
      'aria-controls': panelId,
      'aria-selected': i === 0 ? 'true' : 'false',
      tabindex: i === 0 ? '0' : '-1',
    }, el('span', { text: p.label }));
    const panel = el('div', {
      class: 'branch-detail-tab-panel',
      id: panelId,
      role: 'tabpanel',
      'aria-labelledby': id,
      hidden: i === 0 ? null : '',
    }, p.table);
    tab.addEventListener('click', () => {
      tablist.querySelectorAll('[role="tab"]').forEach((t) => {
        t.setAttribute('aria-selected', 'false');
        t.setAttribute('tabindex', '-1');
      });
      panelWrap.querySelectorAll('[role="tabpanel"]').forEach((pn) => { pn.hidden = true; });
      tab.setAttribute('aria-selected', 'true');
      tab.setAttribute('tabindex', '0');
      panel.hidden = false;
    });
    tablist.append(tab);
    panelWrap.append(panel);
  });

  // Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
  tablist.addEventListener('keydown', (e) => {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (next !== null) {
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    }
  });

  return el('section', { class: 'branch-detail-section branch-detail-tabs' },
    el('h2', { class: 'branch-detail-section-title', text: 'Branch info' }),
    tablist,
    panelWrap);
}

/** Chip list (services / languages). */
function buildChips(label, values) {
  if (!values || !values.length) return null;
  return el('section', { class: 'branch-detail-section' },
    el('h2', { class: 'branch-detail-section-title', text: label }),
    el('ul', { class: 'branch-detail-chips' },
      ...values.map((v) => el('li', { class: 'branch-detail-chip', text: v }))));
}

/** Builds a labelled text field. */
function buildField(id, labelText, { type = 'text', autocomplete } = {}) {
  const input = el('input', {
    class: 'branch-detail-form-input',
    id,
    name: id,
    type,
    autocomplete: autocomplete || 'off',
  });
  const field = el('div', { class: 'branch-detail-form-field' },
    el('label', { class: 'branch-detail-form-label', for: id }, el('span', { text: labelText })),
    input);
  return { field, input };
}

/**
 * Builds the Contact Request form (Name, Product of Interest, Address, Message).
 * Message is a lightweight RTE (contenteditable) with bold/italic/underline.
 * Non-functional submit (demo) — logs the payload and shows a confirmation.
 * Returns the root plus the address input (for Places autocomplete wiring).
 */
function buildContactForm(config, branch) {
  const { form: formCfg } = config;
  const name = buildField('cr-name', formCfg.nameLabel);
  const product = buildField('cr-product', formCfg.productLabel);
  const address = buildField('cr-address', formCfg.addressLabel, { autocomplete: 'off' });
  address.input.setAttribute('placeholder', formCfg.addressPlaceholder);

  // Message RTE (contenteditable div + a tiny toolbar).
  const editor = el('div', {
    class: 'branch-detail-form-rte',
    id: 'cr-message',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': formCfg.messageLabel,
    contenteditable: 'true',
  });
  const rteButton = (cmd, label, glyph) => {
    const b = el('button', {
      class: 'branch-detail-rte-btn', type: 'button', 'aria-label': label, title: label,
    }, el('span', { text: glyph }));
    // execCommand is deprecated but is the simplest dependency-free RTE for a demo.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      editor.focus();
      document.execCommand(cmd, false, null);
    });
    return b;
  };
  const toolbar = el('div', { class: 'branch-detail-rte-toolbar', role: 'toolbar', 'aria-label': 'Text formatting' },
    rteButton('bold', 'Bold', 'B'),
    rteButton('italic', 'Italic', 'I'),
    rteButton('underline', 'Underline', 'U'));
  const messageField = el('div', { class: 'branch-detail-form-field' },
    el('label', { class: 'branch-detail-form-label', for: 'cr-message' }, el('span', { text: formCfg.messageLabel })),
    el('div', { class: 'branch-detail-rte' }, toolbar, editor));

  const status = el('p', { class: 'branch-detail-form-status', role: 'status', hidden: '' });
  const submit = el('button', { class: 'button branch-detail-form-submit', type: 'submit', text: formCfg.submitLabel });

  const form = el('form', { class: 'branch-detail-form' },
    name.field, product.field, address.field, messageField, submit, status);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      branch: branch.branchName || branch.transitNumber || '',
      name: name.input.value.trim(),
      product: product.input.value.trim(),
      address: address.input.value.trim(),
      message: editor.innerHTML.trim(),
    };
    // Demo: no backend. Announce success and reset. A real integration would
    // POST this payload (e.g. to an AEM Forms / Adaptive Form endpoint).
    // eslint-disable-next-line no-console
    console.log('[branch-detail] contact request', payload);
    status.textContent = formCfg.successText;
    status.hidden = false;
    form.dispatchEvent(new CustomEvent('branch-detail:contact-submit', { detail: payload, bubbles: true }));
    name.input.value = '';
    product.input.value = '';
    address.input.value = '';
    editor.textContent = '';
  });

  const root = el('section', { class: 'branch-detail-form-section' },
    el('h2', { class: 'branch-detail-section-title', text: formCfg.title }),
    form);
  return { root, addressInput: address.input };
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

  // Header: name, status, branch type.
  // NB: a <div>, not <header> — the global `header { height }` rule in
  // styles.css targets any <header> and would pin this to the page-nav height.
  const header = el('div', { class: 'branch-detail-header' },
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

  // Hours as a tabbed component (Teller Service / Advisor / ABM).
  const hoursTabs = buildHoursTabs([
    { label: labels.tellerHours, hours: branch.tellerHours },
    { label: labels.advisorHours, hours: branch.advisorHours },
    { label: labels.abmHours, hours: branch.abmHours },
  ]);

  // Right column: map on top, contact request form stacked below it.
  const contactForm = buildContactForm(config, branch);
  const mapCol = el('div', { class: 'branch-detail-map' }, mapCanvas, contactForm.root);

  const body = el('div', { class: 'branch-detail-body' },
    el('div', { class: 'branch-detail-info' }, contact, hoursTabs),
    mapCol);

  return {
    root: el('div', { class: 'branch-detail-inner' }, header, body),
    hasGeo,
    center: hasGeo ? { lat: address.latitude, lng: address.longitude } : null,
    label: branch.branchName || '',
    addressInput: contactForm.addressInput,
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

  const {
    root, hasGeo, center, addressInput,
  } = renderBranch(branch, config, mapWrap);
  block.replaceChildren(root);

  // Initialise Google Maps once, then drive both the map and the address
  // autocomplete from the same load. Graceful fallback if the key is missing
  // or the script fails — the form still works, just without autocomplete.
  let maps = null;
  try {
    maps = await loadGoogleMaps(config.apiKey);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[branch-detail] Google Maps unavailable —', err.message);
  }

  if (maps && hasGeo) {
    const controller = createMap(maps, mapCanvas, { center, zoom: config.mapZoom, mapId: config.mapId });
    controller.setMarkers([{ lat: center.lat, lng: center.lng, title: branch.branchName }]);
  } else {
    mapUnavailable.hidden = false;
    mapUnavailable.style.display = 'flex';
  }

  // Address autocomplete on the contact form (Places library).
  if (maps && addressInput && maps.places?.Autocomplete) {
    try {
      const ac = new maps.places.Autocomplete(addressInput, {
        fields: ['formatted_address'],
        types: ['address'],
        componentRestrictions: { country: ['ca'] },
      });
      ac.addListener('place_changed', () => {
        const place = ac.getPlace();
        if (place?.formatted_address) addressInput.value = place.formatted_address;
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[branch-detail] address autocomplete unavailable —', err.message);
    }
  }

  block.dispatchEvent(new CustomEvent('branch-detail:ready', { detail: { branch }, bubbles: true }));
}
