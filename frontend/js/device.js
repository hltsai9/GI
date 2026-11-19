// Layout by device type, not window width (NFR-01/02b, BUILD_PLAN §1.2).
// Phones get the phone layout; laptops, desktops and tablets get the laptop layout.
const STORAGE_KEY = 'gi.view';

/** h: { userAgent, uaMobile (navigator.userAgentData.mobile, where supported), saved (a manual choice) } */
export function detectDevice(h) {
  if (h.saved === 'phone' || h.saved === 'laptop') return h.saved;
  if (typeof h.uaMobile === 'boolean') return h.uaMobile ? 'phone' : 'laptop';
  const ua = h.userAgent;
  // iPadOS reports itself as a Mac and Android tablets omit "Mobile", so tablets fall through to laptop.
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/Android/.test(ua) && /Mobile/.test(ua)) return 'phone';
  if (/Mobile|Windows Phone|IEMobile|Opera Mini/.test(ua) && !/iPad|Tablet/.test(ua)) return 'phone';
  return 'laptop';
}

export function currentDevice() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked: fall back to detection */
  }
  return detectDevice({ userAgent: navigator.userAgent, uaMobile: navigator.userAgentData?.mobile, saved });
}

/** "Switch to phone / laptop view": remembered on this device. */
export function saveDeviceChoice(d) {
  try {
    if (d) localStorage.setItem(STORAGE_KEY, d);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function isTouchOnly() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
