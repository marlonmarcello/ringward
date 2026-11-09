const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Manager } = require('../src/manager.cjs');
const { readAppearancePreset } = require('../src/appearance.cjs');

const noTattooExport = {
  base: { name: 'Crazy Girl', body_type: 'B', age: 'Young', voice: 'Young 2' },
  skin_color: { skin_r: '226', skin_g: '172', skin_b: '141' },
  face_template: { structure: '6', emphasis: '0', age: '40', aesthetic: '170' },
  face_balance: { size: '150', ratio: '128', protrusion: '186', vert: '76', slant: '53', horiz: '90' },
  forehead: { depth: '114', protrusion: '156', height: '255', prot1: '137', prot2: '102', width: '129' },
  brow_ridge: { height: '89', inner: '75', outer: '220' },
  eyes: { position: '109', size: '140', slant: '255', spacing: '89' },
  nose_ridge: { depth: '89', length: '200', position: '127', tip_height: '0', protrusion: '204', height: '123', slant: '185' },
  nostrils: { slant: '124', size: '139', width: '106' },
  cheeks: { height: '128', depth: '128', width: '90', protrusion: '92', cheeks: '117' },
  lips: { shape: '144', expression: '68', fullness: '156', size: '130', protrusion: '186', thickness: '133' },
  mouth: { protrusion: '151', slant: '128', occlusion: '187', position: '51', width: '145', distance: '106' },
  chin: { tip: '156', length: '87', protrusion: '128', depth: '101', size: '114', height: '116', width: '117' },
  jaw: { protrusion: '159', width: '151', lower: '46', contour: '148' },
  hair: { hair: '33', hair_r: '70', hair_g: '48', hair_b: '29', luster: '148', roots: '128', white: '30' },
  eyebrows: { brow: '10' },
  facial_hair: { beard: '1', stubble: '0' },
  eyelashes: { lashes: '4' },
  right_eye: {
    iris_size: '234', iris_r: '70', iris_g: '48', iris_b: '29', clouding: '0',
    clouding_r: '100', clouding_g: '100', clouding_b: '100', white_r: '255', white_g: '255', white_b: '255', position: '128'
  },
  left_eye: {},
  skin_features: { pores: '44', luster: '200', dark_circles: '20', dark_circles_r: '20', dark_circles_g: '30', dark_circles_b: '25' },
  cosmetics: {
    eyeliner: '35', eyeliner_r: '0', eyeliner_g: '0', eyeliner_b: '0',
    upper: '4', upper_r: '40', upper_g: '20', upper_b: '30',
    lower: '65', lower_r: '15', lower_g: '9', lower_b: '3',
    cheeks: '100', cheeks_r: '140', cheeks_g: '96', cheeks_b: '52',
    lipstick: '170', lipstick_r: '71', lipstick_g: '24', lipstick_b: '24'
  },
  tattoo_mark_eyepatch: { tattoo: '1', flip: 'OFF', eyepatch: '1' },
  body: { head: '128', chest: '128', abdomen: '128', arms: '128', legs: '128', body_hair: '0', muscle: 'Standard' },
  armor: {},
  weapons: {}
};

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ringward-appearance-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('imports the Crazy Girl export with the inactive tattoo controls omitted', async t => {
  const manager = new Manager(await temporaryDirectory(t), '');
  await manager.init({});
  const result = await manager.importPresetJson(JSON.stringify(noTattooExport));
  assert.equal(result.name, 'Crazy Girl');
  assert.equal(result.appearancePreset, true);
  const preset = manager.state.mods[0];
  const { record } = await readAppearancePreset(path.join(manager.modRoot(preset.id), 'appearance.json'));
  assert.equal(record.readUInt32LE(0x3c), 0);
  assert.deepEqual([...record.subarray(0xe9, 0xf0)], [128, 128, 128, 128, 128, 128, 128]);
});

test('validates and preserves the controls for a selected tattoo', async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'preset.json');
  const preset = structuredClone(noTattooExport);
  const tattoo = preset.tattoo_mark_eyepatch;
  tattoo.tattoo = '2';
  await fs.writeFile(file, JSON.stringify(preset));
  await assert.rejects(readAppearancePreset(file), /tattoo_mark_eyepatch\.horiz/);

  Object.assign(tattoo, { horiz: '0', vert: '255', angle: '5', tattoo_r: '6', tattoo_g: '7', tattoo_b: '8' });
  await fs.writeFile(file, JSON.stringify(preset));
  const { record } = await readAppearancePreset(file);
  assert.equal(record.readUInt32LE(0x3c), 1);
  assert.deepEqual([...record.subarray(0xe9, 0xf0)], [0, 255, 5, 128, 6, 7, 8]);

  tattoo.horiz = '256';
  await fs.writeFile(file, JSON.stringify(preset));
  await assert.rejects(readAppearancePreset(file), /tattoo_mark_eyepatch\.horiz/);
});
