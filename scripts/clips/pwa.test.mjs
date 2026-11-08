import assert from 'node:assert/strict';
import test from 'node:test';
import { FILM, PWA_SCREENS, STANDALONE_SCRIPT, VIEWPORT } from './record/pwa.mjs';

test('the PWA recording visits the four installed-application screens in order', () => {
  assert.deepEqual(PWA_SCREENS.map((screen) => screen.screen), ['PWA-01', 'PWA-02', 'PWA-03', 'PWA-04']);
  assert.ok(PWA_SCREENS.every((screen) => screen.path.startsWith('/m')));
});

test('the film is the phone viewport at twice the size, portrait', () => {
  assert.equal(FILM.width, VIEWPORT.width * 2);
  assert.equal(FILM.height, VIEWPORT.height * 2);
});

test('the page script answers display-mode standalone with true', () => {
  assert.match(STANDALONE_SCRIPT, /display-mode/u);
  assert.match(STANDALONE_SCRIPT, /standalone/u);
});
