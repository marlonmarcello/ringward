const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreWindowState } = require('../src/window-state.cjs');

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { workArea: { x: -1600, y: 0, width: 1600, height: 860 } };
const screen = {
  getPrimaryDisplay: () => primary,
  getDisplayMatching: bounds => bounds.x < 0 ? secondary : primary
};

test('restores a saved window on a secondary display', () => {
  const bounds = { x: -1400, y: 70, width: 1100, height: 740 };
  assert.deepEqual(restoreWindowState({ bounds, maximized: true }, screen), {
    options: { ...bounds, minWidth: 830, minHeight: 650 },
    maximized: true
  });
});

test('fits the window onto the remaining display after a display change', () => {
  const screen = {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 800, height: 576 } })
  };
  assert.deepEqual(restoreWindowState({ bounds: { x: 1900, y: 900, width: 1100, height: 740 } }, screen), {
    options: { x: 0, y: 24, width: 800, height: 576, minWidth: 800, minHeight: 576 },
    maximized: false
  });
});

test('uses the default placement when preferences are invalid', () => {
  assert.deepEqual(restoreWindowState({ bounds: { x: null }, maximized: true }, screen), {
    options: { width: 1330, height: 910, minWidth: 830, minHeight: 650 },
    maximized: false
  });
});
