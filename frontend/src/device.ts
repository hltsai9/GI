// Layout by device type, not window width (NFR-01/02b, BUILD_PLAN §1.2).
// Phones get the phone layout; laptops, desktops and tablets get the laptop layout.
export type Device = 'phone' | 'laptop';

const STORAGE_KEY = 'gi.view';

export interface DeviceHints {
  userAgent: string;
  /** navigator.userAgentData?.mobile, where the browser supports Client Hints */
  uaMobile?: boolean;
  /** a manual choice saved on this device */
  saved?: string | null;
}

export function detectDevice(h: DeviceHints): Device {
  if (h.saved === 'phone' || h.saved === 'laptop') return h.saved;
  if (typeof h.uaMobile === 'boolean') return h.uaMobile ? 'phone' : 'laptop';
  const ua = h.userAgent;
  // iPadOS reports itself as a Mac and Android tablets omit "Mobile", so tablets fall through to laptop.
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/Android/.test(ua) && /Mobile/.test(ua)) return 'phone';
  if (/Mobile|Windows Phone|IEMobile|Opera Mini/.test(ua) && !/iPad|Tablet/.test(ua)) return 'phone';
  return 'laptop';
}

export function currentDevice(): Device {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked: fall back to detection */
  }
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return detectDevice({ userAgent: navigator.userAgent, uaMobile: uaData?.mobile, saved });
}

/** "Switch to phone / laptop view": remembered on this device. */
export function saveDeviceChoice(d: Device | null) {
  try {
    if (d) localStorage.setItem(STORAGE_KEY, d);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function isTouchOnly(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
