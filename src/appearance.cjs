const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const PRESET_FILE = /\.json$/i;
const PRESET_LIMIT = 1024 ** 2;
const SAVE_LIMIT = 64 * 1024 ** 2;
const GLOBAL_START = 0x300 + 10 * 0x280010;
const GLOBAL_END = GLOBAL_START + 0x60010;
const FAVORITES_START = GLOBAL_START + 0x164;
const FAVORITE_SIZE = 0x130;
const FAVORITE_COUNT = 15;

// Elden Ring character creation uses one-based display choices. The stored IDs
// follow CharMakeMenuListItemParam rows 700–736, 800–837, and 900–903.
const HAIR = [0, 113, 112, 1, 3, 100, 5, 10, 101, 9, 8, 6, 7, 115, 114, 2,
  4, 102, 103, 104, 105, 106, 107, 109, 108, 111, 110, 117, 119, 118, 116,
  121, 125, 122, 120, 123, 124];
const EYEPATCH = [0, 2, 1, 10];

// Offsets are relative to a PC Favorites record. Related sliders that are
// contiguous on disk share one entry. Gaps are reserved or linked settings.
const SLIDERS = [
  [0x44, 'face_template', 'age aesthetic emphasis'],
  [0x48, 'brow_ridge', 'height inner outer'],
  [0x4b, 'cheeks', 'height depth width protrusion cheeks'],
  [0x50, 'chin', 'tip length protrusion depth size height width'],
  [0x57, 'eyes', 'position size slant spacing'],
  [0x5b, 'face_balance', 'size ratio'],
  [0x5e, 'face_balance', 'protrusion vert slant horiz'],
  [0x63, 'forehead', 'depth protrusion'],
  [0x66, 'jaw', 'protrusion width lower contour'],
  [0x6a, 'lips', 'shape size fullness expression protrusion thickness'],
  [0x70, 'mouth', 'protrusion slant occlusion position width distance'],
  [0x76, 'nose_ridge', 'depth length position tip_height'],
  [0x7a, 'nostrils', 'slant size width'],
  [0x7d, 'nose_ridge', 'protrusion'],
  [0x7e, 'forehead', 'height prot1 prot2 width'],
  [0x82, 'nose_ridge', 'height slant'],
  [0xc4, 'body', 'head chest abdomen arms legs arms legs'],
  [0xcb, 'skin_color', 'skin_r skin_g skin_b'],
  [0xce, 'skin_features', 'luster pores'],
  [0xd0, 'facial_hair', 'stubble'],
  [0xf2, 'body', 'body_hair'],
  [0x10e, 'hair', 'hair_r hair_g hair_b luster roots white']
];
const EYE_FIELDS = 'iris_r iris_g iris_b iris_size clouding clouding_r clouding_g clouding_b white_r white_g white_b position'.split(' ');
const MAKEUP = [
  [0xd1, 'skin_features', 'dark_circles'],
  [0xd5, 'cosmetics', 'cheeks'], [0xd9, 'cosmetics', 'eyeliner'], [0xdd, 'cosmetics', 'lower'],
  [0xe1, 'cosmetics', 'upper'], [0xe5, 'cosmetics', 'lipstick']
];

function slider(data, group, key, fallback, min = 0, max = 255) {
  const input = data[group]?.[key] ?? fallback;
  const value = typeof input === 'string' && /^\d{1,3}$/.test(input) ? Number(input) : input;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(group + '.' + key + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  return value;
}

function readRecord(data) {
  if (!data || typeof data !== 'object' || !['A', 'B'].includes(data.base?.body_type) || !data.face_template) {
    throw new Error('Choose an Elden Sliders JSON export with a body type and face template.');
  }
  const record = Buffer.alloc(FAVORITE_SIZE);
  record[8] = 1;
  record[9] = Number(data.base.body_type === 'B');
  record.write('FACE', 0x18, 'ascii');
  record.writeUInt32LE(4, 0x1c);
  record.writeUInt32LE(0x120, 0x20);
  record.writeUInt32LE((slider(data, 'face_template', 'structure', undefined, 1, 15) - 1) * 10, 0x24);
  record.writeUInt32LE(HAIR[slider(data, 'hair', 'hair', undefined, 1, HAIR.length) - 1], 0x28);
  record.writeUInt32LE(slider(data, 'eyebrows', 'brow', undefined, 1, 17) - 1, 0x30);
  record.writeUInt32LE(slider(data, 'facial_hair', 'beard', undefined, 1, 12) - 1, 0x34);
  record.writeUInt32LE(EYEPATCH[slider(data, 'tattoo_mark_eyepatch', 'eyepatch', 1, 1, EYEPATCH.length) - 1], 0x38);
  const tattoo = slider(data, 'tattoo_mark_eyepatch', 'tattoo', undefined, 1, 38) - 1;
  record.writeUInt32LE(tattoo >= 19 ? tattoo + 1 : tattoo, 0x3c);
  record.writeUInt32LE(slider(data, 'eyelashes', 'lashes', undefined, 1, 4) - 1, 0x40);

  for (const [offset, group, keys] of SLIDERS) {
    keys.split(' ').forEach((key, index) => { record[offset + index] = slider(data, group, key); });
  }
  // Elden Bling omits the tattoo controls when the no-tattoo model is selected.
  const tattooFallback = tattoo === 0 ? 128 : undefined;
  for (const [index, key] of ['horiz', 'vert', 'angle'].entries()) {
    record[0xe9 + index] = slider(data, 'tattoo_mark_eyepatch', key, tattooFallback);
  }
  for (const [offset, group, key] of MAKEUP) {
    const intensity = slider(data, group, key);
    record[offset] = intensity;
    for (const [index, channel] of [...'rgb'].entries()) {
      record[offset + 1 + index] = slider(data, group, key + '_' + channel, intensity === 0 ? 0 : undefined);
    }
  }
  EYE_FIELDS.forEach((key, index) => {
    record[0xf6 + index] = slider(data, 'right_eye', key);
    record[0x102 + index] = slider(data, 'left_eye', key, record[0xf6 + index]);
  });
  for (const [section, prefix, offset] of [['facial_hair', 'beard', 0x114], ['eyebrows', 'brow', 0x11a]]) {
    [prefix + '_r', prefix + '_g', prefix + '_b', 'luster', 'roots', 'white'].forEach((key, index) => {
      record[offset + index] = slider(data, section, key, record[0x10e + index]);
    });
  }
  for (const [index, channel] of [...'rgb'].entries()) {
    record[0xed + index] = slider(data, 'tattoo_mark_eyepatch', 'tattoo_' + channel, tattooFallback);
    record[0xf3 + index] = slider(data, 'body', 'body_hair_' + channel, record[0x10e + index]);
    record[0x123 + index] = slider(data, 'tattoo_mark_eyepatch', 'eyepatch_' + channel, 128);
    record[0x120 + index] = slider(data, 'eyelashes', 'lashes_' + channel, record[0x10e + index]);
  }
  record[0xec] = slider(data, 'tattoo_mark_eyepatch', 'expansion', 128);
  const flip = String(data.tattoo_mark_eyepatch?.flip ?? 'OFF').toUpperCase();
  if (!['OFF', 'ON', '0', '1'].includes(flip)) throw new Error('Tattoo flip must be On or Off.');
  record[0xf0] = 128; // Decal gloss has no slider in the JSON export.
  record[0xf1] = Number(flip === 'ON' || flip === '1');
  return record;
}

async function readAppearancePreset(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.size > PRESET_LIMIT) throw new Error('Choose a preset JSON file under 1 MB.');
  return parseAppearancePreset(await fs.readFile(file, 'utf8'));
}

function parseAppearancePreset(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > PRESET_LIMIT) throw new Error('Choose a preset JSON under 1 MB.');
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The preset file is not valid JSON.');
  }
  return {
    name: typeof data?.base?.name === 'string' ? data.base.name : '',
    record: readRecord(data)
  };
}

function checksum(save) {
  return createHash('md5').update(save.subarray(GLOBAL_START + 16, GLOBAL_END)).digest();
}

function favorites(save) {
  if (save.length < GLOBAL_END || save.toString('ascii', 0, 4) !== 'BND4' ||
      save.readUInt32LE(0x0c) !== 12 || save.readBigUInt64LE(0x28) !== 0x300n ||
      save.readUInt32LE(GLOBAL_START + 0x15c) !== 0 ||
      save.readUInt32LE(GLOBAL_START + 0x160) !== 0x1800 ||
      save.readUInt32LE(FAVORITES_START) !== 0xface ||
      save.readUInt32LE(FAVORITES_START + 4) !== FAVORITE_COUNT * FAVORITE_SIZE) {
    throw new Error('This file does not match the supported Elden Ring PC save layout.');
  }
  if (!save.subarray(GLOBAL_START, GLOBAL_START + 16).equals(checksum(save))) {
    throw new Error('This save failed its Favorites checksum.');
  }
  return Array.from({ length: FAVORITE_COUNT }, (_, index) => {
    const offset = FAVORITES_START + index * FAVORITE_SIZE;
    return save.subarray(offset, offset + FAVORITE_SIZE);
  });
}

function usedFavorite(record) {
  return record[8] === 1 && record[9] <= 1 && record.toString('ascii', 0x18, 0x1c) === 'FACE' &&
    record.readUInt32LE(0x1c) === 4 && record.readUInt32LE(0x20) === 0x120;
}

function emptyFavorite(record) {
  return record.subarray(0, 0x14).every(byte => byte === 0) &&
    [0, -1].includes(record.readInt32LE(0x14)) && record.subarray(0x18).every(byte => byte === 0);
}

function appearanceKey(record) {
  return createHash('sha256').update(record.subarray(9, 10)).update(record.subarray(0x24, 0x84))
    .update(record.subarray(0xc4, 0x126)).digest('hex');
}

function slotRevision(record) {
  return createHash('sha256').update(record).digest('hex');
}

function listFavorites(save) {
  return favorites(save).map((record, index) => {
    const used = usedFavorite(record);
    const status = index === 0 ? 'reserved' : used ? 'occupied' : emptyFavorite(record) ? 'empty' : 'unavailable';
    return {
      slot: index + 1, status, revision: slotRevision(record),
      bodyType: used ? (record[9] === 1 ? 'B' : 'A') : null, key: used ? appearanceKey(record) : null
    };
  });
}

function checkedSlot(slots, target) {
  const slot = target?.slot;
  if (!Number.isInteger(slot) || slot < 2 || slot > slots.length) throw new Error('Choose an editable Favorites slot.');
  const record = slots[slot - 1];
  if (slotRevision(record) !== target.revision) throw new Error('This slot changed. Refresh Favorites before editing it.');
  if (!usedFavorite(record)) throw new Error('Choose a filled Favorites slot.');
  return slot - 1;
}

function writeFavorite(save, index, record) {
  const result = Buffer.from(save);
  record.copy(result, FAVORITES_START + index * FAVORITE_SIZE);
  checksum(result).copy(result, GLOBAL_START);
  if (!favorites(result)[index].equals(record)) throw new Error('Could not verify the Favorites change.');
  return { slot: index + 1, save: result };
}

function addFavorite(save, preset, target) {
  const slots = favorites(save);
  const index = target ? checkedSlot(slots, target) : slots.findIndex((slot, i) => i > 0 && emptyFavorite(slot));
  const key = appearanceKey(preset);
  const duplicate = slots.findIndex((slot, i) => i > 0 && usedFavorite(slot) && appearanceKey(slot) === key);
  if (duplicate >= 0) return { slot: duplicate + 1, already: true };
  if (index < 0) throw new Error('This save has no empty Favorites slot. Remove a Favorite to make room.');

  const record = Buffer.from(preset);
  const template = slots.find(slot => usedFavorite(slot) && slot[9] === record[9]) || slots.find(usedFavorite);
  if (template) {
    template.copy(record, 0x84, 0x84, 0xc4);
  } else {
    record[0x84] = 128;
    record.fill(128, 0x89, 0x8e);
    record.fill(128, 0x97, 0x9b);
    record.fill(128, 0x9f, 0xc3);
  }
  return writeFavorite(save, index, record);
}

function removeFavorite(save, target) {
  return writeFavorite(save, checkedSlot(favorites(save), target), Buffer.alloc(FAVORITE_SIZE));
}

async function readPcSave(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.size > SAVE_LIMIT) throw new Error('Choose a supported Elden Ring PC save.');
  return fs.readFile(file);
}

module.exports = {
  PRESET_FILE, PRESET_LIMIT, readAppearancePreset,
  readPcSave, appearanceKey, listFavorites, addFavorite, removeFavorite
};
