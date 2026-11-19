// Optional check for the device detection, with Node's built-in test runner (no packages):
//   node --test frontend/tests/device.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDevice } from '../js/device.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  galaxyTab: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

test('phones get the phone layout', () => {
  assert.equal(detectDevice({ userAgent: UA.iphone }), 'phone');
  assert.equal(detectDevice({ userAgent: UA.pixel }), 'phone');
});

test('tablets, laptops and desktops get the laptop layout', () => {
  for (const ua of [UA.ipad, UA.galaxyTab, UA.windows, UA.mac]) assert.equal(detectDevice({ userAgent: ua }), 'laptop');
});

test('Client Hints win over the user-agent string', () => {
  assert.equal(detectDevice({ userAgent: UA.windows, uaMobile: true }), 'phone');
  assert.equal(detectDevice({ userAgent: UA.pixel, uaMobile: false }), 'laptop');
});

test('a saved choice overrides detection', () => {
  assert.equal(detectDevice({ userAgent: UA.iphone, saved: 'laptop' }), 'laptop');
  assert.equal(detectDevice({ userAgent: UA.windows, saved: 'phone' }), 'phone');
  assert.equal(detectDevice({ userAgent: UA.windows, saved: 'garbage' }), 'laptop');
});
