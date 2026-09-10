/*
 * Google Maps loader for the locator block.
 *
 * Loads the Google Maps JavaScript API on demand from a page-supplied API key
 * (never hardcoded) and exposes a tiny map controller — init, drop markers,
 * fit bounds. If no key is configured or the script fails to load, the caller
 * falls back to the "map unavailable" state; the rest of the block still works.
 *
 * The key is a PUBLIC, client-side key. It must be restricted by HTTP referrer
 * in the Google Cloud console — not treated as a secret.
 */

let loaderPromise = null;

/**
 * Dynamically loads the Google Maps JS API exactly once per page.
 * @param {string} apiKey Google Maps JavaScript API key
 * @returns {Promise<google.maps>} resolves with the maps namespace
 */
export function loadGoogleMaps(apiKey) {
  if (!apiKey) return Promise.reject(new Error('missing-api-key'));
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    const callbackName = '__locatorGmapsReady';
    window[callbackName] = () => {
      resolve(window.google.maps);
      delete window[callbackName];
    };
    const script = document.createElement('script');
    const params = new URLSearchParams({
      key: apiKey,
      loading: 'async',
      callback: callbackName,
      libraries: 'marker',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.addEventListener('error', () => {
      loaderPromise = null;
      reject(new Error('google-maps-load-failed'));
    });
    document.head.append(script);
  });
  return loaderPromise;
}

/**
 * Creates a map controller bound to a container element.
 * @param {google.maps} maps the loaded maps namespace
 * @param {HTMLElement} container the map render target
 * @param {{center:{lat:number,lng:number}, zoom:number}} options
 */
export function createMap(maps, container, options) {
  const map = new maps.Map(container, {
    center: options.center,
    zoom: options.zoom,
    mapId: options.mapId || undefined,
    disableDefaultUI: false,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
  });

  // A map created while its container has zero size renders blank (grey) and
  // never recovers on its own — no error is thrown. This is the most common
  // "empty map" cause when a block is lazy-decorated before layout settles.
  // Watch the container: whenever it gains/changes size, nudge Maps to relayout
  // and re-apply the current view so the tiles paint.
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = container;
      if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
        lastW = w;
        lastH = h;
        const center = map.getCenter();
        maps.event.trigger(map, 'resize');
        if (center) map.setCenter(center);
      }
    });
    ro.observe(container);
  }

  let markers = [];
  let infoWindow = null;

  const clearMarkers = () => {
    markers.forEach((m) => { m.map = null; m.setMap?.(null); });
    markers = [];
  };

  return {
    map,
    /**
     * Replaces all markers with the given points and fits the viewport to them.
     * @param {Array<{lat:number,lng:number,title?:string,content?:string}>} points
     */
    setMarkers(points = []) {
      clearMarkers();
      if (!infoWindow) infoWindow = new maps.InfoWindow();
      const bounds = new maps.LatLngBounds();
      points.forEach((p) => {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
        const position = { lat: p.lat, lng: p.lng };
        const marker = new maps.Marker({ position, map, title: p.title || '' });
        if (p.content) {
          marker.addListener('click', () => {
            infoWindow.setContent(p.content);
            infoWindow.open({ anchor: marker, map });
          });
        }
        markers.push(marker);
        bounds.extend(position);
      });
      if (markers.length === 1) {
        map.setCenter(bounds.getCenter());
        map.setZoom(14);
      } else if (markers.length > 1) {
        map.fitBounds(bounds, 48);
      }
    },
    clearMarkers,
  };
}
