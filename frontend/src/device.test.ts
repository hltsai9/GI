import { describe, expect, it } from 'vitest';
import { detectDevice } from './device';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  galaxyTab: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

describe('detectDevice', () => {
  it('gives phones the phone layout', () => {
    expect(detectDevice({ userAgent: UA.iphone })).toBe('phone');
    expect(detectDevice({ userAgent: UA.pixel })).toBe('phone');
  });

  it('gives tablets, laptops and desktops the laptop layout', () => {
    for (const ua of [UA.ipad, UA.galaxyTab, UA.windows, UA.mac]) expect(detectDevice({ userAgent: ua })).toBe('laptop');
  });

  it('prefers Client Hints over the user-agent string', () => {
    expect(detectDevice({ userAgent: UA.windows, uaMobile: true })).toBe('phone');
    expect(detectDevice({ userAgent: UA.pixel, uaMobile: false })).toBe('laptop');
  });

  it('lets a saved choice override detection', () => {
    expect(detectDevice({ userAgent: UA.iphone, saved: 'laptop' })).toBe('laptop');
    expect(detectDevice({ userAgent: UA.windows, saved: 'phone' })).toBe('phone');
    expect(detectDevice({ userAgent: UA.windows, saved: 'garbage' })).toBe('laptop');
  });
});
