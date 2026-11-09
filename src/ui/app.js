const app = window.ringward;
const $ = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
const icon = name => '<svg aria-hidden="true"><use href="#' + name + '"/></svg>';
const views = { profile: ['layers', 'Loadout'], library: ['box', 'Mod library'], reshade: ['eye', 'ReShade'], presets: ['star', 'Presets'], nexus: ['globe', 'Nexus Mods'], saves: ['save', 'Save backups'], settings: ['settings', 'Settings'] };
const number = value => new Intl.NumberFormat().format(value);
let state;
let view = 'profile';
let loading = false;
let toastTimer;
let modalAction;
let details;
let incoming = [];
let mergeReport;
const LOADOUT_DRAG = 'application/x-ringward-loadout';
let draggedRow;
let dropRow;
const listFilters = { profile: { query: '', status: 'all' }, library: { query: '', status: 'all' } };
const modStatuses = { all: 'All', enabled: 'Enabled', disabled: 'Disabled' };
let presetState = null;
let presetDraft = '';

const profile = () => state.profiles.find(p => p.id === state.active);
const mod = id => state.mods.find(m => m.id === id);
const fullyVanilla = () => profile().immutable && !state.visual;
function visualName() {
  if (!state.visual) return 'Off';
  const item = mod(state.visual.id);
  return item?.reshadePresets.length > 1 ? state.visual.file.split('/').at(-1) : item?.name || 'Selected';
}
const button = (action, label, classes = '', attr = '') =>
  '<button type="button" data-action="' + action + '" class="' + classes + '" ' + attr + '>' + label + '</button>';
const data = id => 'data-id="' + html(id) + '"';
const tag = (label, type = '') => '<span class="tag ' + type + '">' + html(label) + '</span>';
const panel = (heading, description, body, actions = '') => '<section class="panel"><div class="panel-head"><div><h2>' +
  heading + '</h2>' + (description ? '<p>' + description + '</p>' : '') + '</div>' + actions + '</div>' + body + '</section>';
const body = content => '<div class="panel-body">' + content + '</div>';
const title = (kicker, heading, description) => '<p class="eyebrow">' + kicker + '</p><h1>' + heading +
  '</h1><p class="intro">' + description + '</p>';
const line = (name, description, right) => '<div class="card-line"><div><strong>' + name + '</strong><small>' +
  description + '</small></div><div class="actions">' + right + '</div></div>';
const checkbox = (name, label, checked) => '<label><input type="checkbox" name="' + name + '" ' +
  (checked ? 'checked' : '') + '> ' + label + '</label>';
const check = (name, label, checked) => '<li>' + checkbox(name, label, checked) + '</li>';
const importZip = () => button('import-zip', icon('plus') + ' Import mod');
const importFolder = () => button('import-folder', 'Import folder', 'subtle');
function navigate(name) {
  view = name;
  render();
  if (name === 'presets') return loadPresetSlots();
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').hidden = false;
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 15_000 : 5_000);
}

async function refresh() {
  state = await app.invoke('state');
  render();
}

async function perform(work, success) {
  if (loading) return;
  loading = true;
  try {
    const result = await work();
    await refresh();
    if (success) toast(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (error) {
    toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
  } finally {
    loading = false;
  }
}

function dialog(title, content, submitLabel, action) {
  const element = $('dialog');
  if (element.open) element.close();
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = content;
  $('dialog-submit').hidden = !action;
  $('dialog-submit').textContent = submitLabel || 'Save';
  modalAction = action;
  element.showModal();
}

function confirm(title, message, label, work, success) {
  dialog(title, '<p>' + html(message) + '</p>', label, () => perform(work, success));
}

function render() {
  const active = profile();
  const links = Object.entries(views).map(([key, [glyph, name]]) =>
    button('nav', icon(glyph) + ' ' + name, view === key ? 'selected' : '', data(key) + (view === key ? ' aria-current="page"' : ''))).join('');
  $('rail').innerHTML = '<div class="brand"><img src="./assets/logo.svg" alt=""><div><strong>Ringward</strong><small>Elden Ring manager</small></div></div>' +
    '<nav class="navigation">' + links + '</nav><div class="caption">Profiles' +
    button('profile-create', icon('plus'), 'icon', 'aria-label="Create profile" title="Create profile"') +
    '</div><div class="profile-list">' + state.profiles.map(item =>
      button('profile-select', '<span class="dot ' + (item.id === active.id ? 'on' : '') + '"></span><span>' + html(item.name) + '</span>',
        item.id === active.id ? 'selected' : '', data(item.id) + ' title="' + html(item.name) + '"')).join('') +
    '</div><div class="rail-footer"><span class="dot ' + (state.tools.me3 ? 'on' : '') + '"></span> ' +
    (state.tools.me3 ? 'ME3 ready' : 'ME3 setup needed') + ' · Windows</div>';
  $('topbar').innerHTML = '<div class="trail">Elden Ring <strong>/ &nbsp;' + html(views[view][1]) +
    '</strong></div><div class="actions">' + importZip() +
    button('launch', icon('play') + (state.running ? ' Running' : fullyVanilla() ? ' Launch via Steam' : ' Launch offline'),
      'primary', state.running ? 'disabled' : '') + '</div>';
  $('content').innerHTML = { profile: loadout, library, reshade: visuals, presets, nexus, saves, settings }[view]();
  document.body.classList.remove('starting');
  filterMods();
}

function modFilters(label) {
  const filter = listFilters[view];
  const statuses = Object.entries(modStatuses).map(([value, name]) => '<option value="' + value + '"' +
    (filter.status === value ? ' selected' : '') + '>' + name + '</option>').join('');
  return '<div class="mod-search"><input type="search" data-mod-search aria-label="' + label + '" placeholder="' +
    label + '" value="' + html(filter.query) + '"><label class="mod-status">Status<select data-mod-status>' +
    statuses + '</select></label><small data-search-count></small></div>';
}

function searchText(item) {
  return html([item.name, item.archive, item.nexus?.modId, item.nexus?.fileId].filter(Boolean).join(' ').toLowerCase());
}

function filterMods() {
  const input = document.querySelector('[data-mod-search]');
  if (!input) return;
  const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const status = listFilters[view].status;
  const filtered = terms.length > 0 || status !== 'all';
  const rows = [...document.querySelectorAll('[data-search-text]')];
  let visible = 0;
  for (const row of rows) {
    row.hidden = (status !== 'all' && row.dataset.modStatus !== status) ||
      !terms.every(term => row.dataset.searchText.includes(term));
    if (!row.hidden) visible++;
    const handle = row.querySelector('.drag-handle');
    if (handle) handle.draggable = !filtered;
    for (const button of row.querySelectorAll('[data-order-edge]')) {
      button.disabled = filtered || button.dataset.orderEdge === 'true';
    }
  }
  const empty = document.querySelector('[data-search-empty]');
  if (empty) empty.hidden = !rows.length || visible > 0;
  const hint = view === 'profile' && filtered ? ' · Clear filters to reorder' : '';
  document.querySelector('[data-search-count]').textContent = filtered ? visible + ' of ' + rows.length + hint : '';
}

const noMatches = '<div class="empty" data-search-empty hidden>No matching mods.</div>';

function loadout() {
  const active = profile();
  const visualLine = line('ReShade', html(visualName()), button('nav', 'Manage ReShade', '', data('reshade')));
  if (active.immutable) {
    const launchText = fullyVanilla()
      ? 'Steam starts Elden Ring with its standard launcher and saves.'
      : 'ME3 starts Elden Ring offline with only your ReShade preset and the game’s standard saves.';
    return '<section class="hero"><p class="eyebrow">Built-in gameplay profile</p><h1>Vanilla</h1>' +
      '<p>Original Elden Ring gameplay. Choose ReShade separately to change the visuals.</p></section>' +
      '<div class="stack narrow">' + panel('Launch settings', launchText, body(visualLine)) + '</div>';
  }
  const report = state.plan;
  const enabled = active.mods.filter(item => item.enabled).length;
  const count = enabled + ' enabled · ' + number(report.assets) + ' asset files · ' + report.nativeCount + ' native DLLs';
  const rows = active.mods.map((entry, index) => {
    const item = mod(entry.id);
    const attr = data(entry.id);
    const csvCount = entry.csv?.length || 0;
    const needsSetup = entry.root === null && !entry.natives.length && !csvCount;
    const summary = [
      entry.root !== null ? (entry.root || 'Archive root') : 'No asset folder',
      entry.overlays?.length ? entry.overlays.length + ' optional folders' : '',
      entry.natives.length ? entry.natives.length + ' DLLs' : '',
      csvCount ? csvCount + ' CSV patches' : ''
    ].filter(Boolean).map(html).join(' · ');
    return '<div class="row ' + (entry.enabled ? '' : 'off') + '" data-loadout-mod="' + html(entry.id) +
      '" data-mod-status="' + (entry.enabled ? 'enabled' : 'disabled') + '" data-search-text="' + searchText(item) +
      '"><span class="drag-handle" draggable="true" title="Drag to reorder">' +
      icon('grip') + '</span><span class="number">' + (index + 1) +
      '</span><input type="checkbox" data-toggle="' + entry.id + '" aria-label="Enable ' + html(item.name) + '" ' +
      (entry.enabled ? 'checked' : '') + '><div class="item"><strong>' + html(item.name) + '</strong><small>' + summary + '</small></div>' +
      (needsSetup ? tag('Setup', 'attn') : item.csvs?.length && !csvCount ? tag('CSV available') : '') +
      (item.warnings?.length ? tag('Import notes', 'attn') : '') + '<div class="actions">' +
      button('move-up', icon('up'), 'icon', attr + ' aria-label="Move up" title="Move up" data-order-edge="' + (index === 0) + '"') +
      button('move-down', icon('down'), 'icon', attr + ' aria-label="Move down" title="Move down" data-order-edge="' + (index === active.mods.length - 1) + '"') +
      button('mod-setup', 'Manage', '', attr) + '</div></div>';
  }).join('');
  const empty = '<div class="empty"><h3>This loadout is empty</h3><p>Import a mod or add one from your library.</p><div class="actions">' +
    importZip() + importFolder() + '</div></div>';
  const merge = report.regulations.length
    ? line('Regulation changes', report.regulations.length + ' inputs · compared against vanilla',
      button('merge-review', 'Review & build'))
    : line('Regulation changes', 'No regulation changes', tag('Clear', 'ok'));
  const conflicts = report.assetConflictCount
    ? line('Asset overrides', report.assetConflictCount + ' shared paths · lower rows win', button('asset-conflicts', 'View'))
    : line('Asset overrides', 'No overlapping asset paths', tag('Clear', 'ok'));
  return '<section class="hero"><img class="sigil" src="./assets/logo.svg" alt=""><p class="eyebrow">Active loadout</p><h1>' +
    html(active.name) + '</h1><p>' + count + '</p><div class="actions">' +
    button('profile-settings', icon('settings') + ' Profile settings') + button('profile-duplicate', 'Duplicate', 'subtle') +
    '</div></section>' + dropzone() + '<div class="columns"><div>' +
    panel('Load order', 'Drag by the handle to reorder. Mods farther down have higher priority.',
      rows ? modFilters('Search loadout') + rows + noMatches : empty,
      button('nav', 'Open library ' + icon('arrow'), 'subtle', data('library'))) +
    '</div><div class="stack">' + panel('Compatibility', '', body(conflicts + merge +
      (report.incomplete.length ? line('Setup required', html(report.incomplete.join(', ')), tag('Review', 'attn')) : ''))) +
    panel('Launch settings', '', body(
      visualLine +
      line('Matchmaking', 'ME3 offline mode', tag('Offline', 'ok')) +
      line('Save file', active.isolated ? 'Separate for this profile' : 'Game default', tag(active.isolated ? 'Isolated' : 'Shared', active.isolated ? 'ok' : 'attn')) +
      line('Automatic backups', active.autoBackup ? 'Before each launch' : 'Manual backups only', tag(active.autoBackup ? 'On' : 'Off')) +
      line('ME3 output', 'Recent launch output', button('view-log', 'View log'))
    )) + '</div></div>';
}

function dropzone() {
  return '<div class="dropzone" id="dropzone"><div><strong>Drop mod files or folders here</strong><small>Import ZIP, 7z, RAR, Smithbox CSV, ReShade INI, Elden Sliders JSON, or a folder.</small></div><div class="actions">' +
    importFolder() + '</div></div>';
}

function library() {
  const active = profile();
  const loadoutMods = new Map(active.mods.map(entry => [entry.id, entry]));
  const entries = state.mods.map(item => {
    const attr = data(item.id);
    const entry = loadoutMods.get(item.id);
    const status = entry ? (entry.enabled ? 'enabled' : 'disabled') : 'unassigned';
    const row = '<div class="row" data-search-text="' + searchText(item) + '" data-mod-status="' + status + '">';
    if (item.reshadeOnly) {
      return row + icon('file') + '<div class="item"><strong>' + html(item.name) + '</strong><small>' +
        item.reshadePresets.length + ' ReShade preset' + (item.reshadePresets.length === 1 ? '' : 's') + '</small></div>' +
        button('nav', 'Open ReShade', '', data('reshade')) + button('library-mod', 'Manage', '', attr) + '</div>';
    }
    if (item.appearancePreset) {
      return row + icon('file') + '<div class="item"><strong>' + html(item.name) +
        '</strong><small>Elden Sliders JSON · Character appearance</small></div>' + tag('Appearance preset') +
        button('apply-preset', 'Add to Favorites', '', attr) + button('library-mod', 'Manage', '', attr) + '</div>';
    }
    if (item.sliderSheets?.length) {
      return row + icon('file') + '<div class="item"><strong>' + html(item.name) +
        '</strong><small>Character preset · Enter sliders in Elden Ring</small></div>' + tag('Slider guide') +
        button('view-sliders', 'View sliders', '', attr) + button('library-mod', 'Manage', '', attr) + '</div>';
    }
    return row + icon('box') + '<div class="item"><strong>' + html(item.name) + '</strong><small>' +
      number(item.fileCount) + ' files · ' + item.candidates.length + ' asset folders · ' + item.natives.length + ' DLLs' +
      (item.csvs?.length ? ' · ' + item.csvs.length + ' CSV patches' : '') +
      (item.nexus?.version ? ' · Nexus ' + html(item.nexus.version) : '') +
      '</small></div>' + (entry ? tag(modStatuses[status], entry.enabled ? 'ok' : '') :
        active.immutable ? '' : button('mod-add', 'Add to profile', '', attr)) +
      button('library-mod', 'Manage', '', attr) + '</div>';
  }).join('');
  return title('Collection', 'Mod library', 'Manage installed mods and character presets.') + dropzone() +
    panel('Library items', number(state.mods.length) + ' in library · Status in ' + html(active.name),
      entries ? modFilters('Search mod library') + entries + noMatches : '<div class="empty"><h3>No mods imported yet</h3><p>Start with a mod archive or an extracted folder.</p></div>',
      button('open-data', 'Open folder', 'subtle', data('library')));
}

function visuals() {
  const { reshade: ready, reshadeInstalled, me3, me3Version, me3ReShade } = state.tools;
  const active = state.visual;
  const me3Description = me3Version ? 'Installed version ' + html(me3Version) :
    me3 ? 'Installed version could not be read' : 'ME3 0.13.0 or newer required';
  const me3Action = me3ReShade ? tag('Compatible', 'ok') : me3 ?
    button('reshade-me3', 'Install compatible ME3') : button('install-me3', 'Install ME3', 'primary');
  const install = ready ? tag('Ready', 'ok') : button('install-reshade', icon('download') + ' Install ReShade', 'primary');
  const uninstall = reshadeInstalled ? button('uninstall-reshade', 'Uninstall ReShade', 'danger') : '';
  const rows = state.mods.flatMap(item => (item.reshadePresets || []).map((preset, index) => {
    const selected = active?.id === item.id && active.file === preset.file;
    const file = preset.file.split('/').at(-1);
    const name = item.reshadePresets.length > 1 ? file.replace(/\.ini$/i, '') : item.name;
    const description = preset.effects.length
      ? preset.effects.length + ' enabled shader files · ' + file
      : 'ReShade preset · ' + file;
    return line(html(name), html(description),
      button(selected ? 'reshade-off' : 'reshade-select', selected ? 'Unselect' : 'Select', '',
        data(item.id) + ' data-index="' + index + '" aria-label="' + (selected ? 'Unselect ' : 'Select ') + html(name) + '"') +
      button('library-mod', 'Manage', 'subtle', data(item.id)));
  })).join('');
  const presetSummary = active ? html(visualName()) + ' is selected for the next launch.' : 'ReShade is off for the next launch.';
  return '<div class="stack narrow">' +
    title('Visual effects', 'ReShade', 'Choose how Elden Ring looks on your next offline launch.') +
    panel('ReShade setup', 'ReShade uses ME3 0.13.0 or newer.',
      body(line('ReShade ' + html(state.reshadeVersion), ready ? 'Runtime and shader collections installed' : 'Download the runtime and shader collections',
        install + uninstall) +
      line('Mod Engine 3', me3Description, me3Action) +
      line('ReShade log', 'Shader loading and compilation messages', button('reshade-log', 'View log'))),
      button('open-external', 'ReShade website', 'subtle', data('reshade'))) +
    panel('ReShade presets', presetSummary,
      body(rows || '<p>Import a ZIP or INI to add a preset.</p>'), button('import-reshade', icon('plus') + ' Import preset')) +
    '</div>';
}

const savedPresets = () => state.mods.filter(item => item.appearancePreset);
const selectedPresetSave = () => presetState?.saves.find(save => save.relative === presetState.selected);

async function loadPresetSlots(relative = presetState?.selected) {
  return perform(async () => { presetState = await app.invoke('presets:state', relative); });
}

function presets() {
  const input = '<form id="paste-preset" class="stack"><label class="field">Preset JSON' +
    '<textarea name="json" data-preset-draft spellcheck="false" rows="5" required placeholder="Paste the JSON export here">' +
    html(presetDraft) + '</textarea></label><div class="actions"><button type="submit" class="primary">Import JSON</button>' +
    button('open-external', 'Elden Sliders', 'subtle', data('eldenSliders')) +
    button('open-external', 'Elden Bling Sliders', 'subtle', data('eldenBling')) + '</div></form>';
  const entries = savedPresets();
  const selected = selectedPresetSave();
  const available = presetState?.slots.some(slot => slot.status === 'empty');
  const libraryRows = entries.map(item => '<div class="row">' + icon('file') + '<div class="item"><strong>' + html(item.name) +
    '</strong><small>Appearance JSON</small></div>' + button('preset-add', 'Add Favorite', '', data(item.id) +
      (!available || state.running ? ' disabled' : '')) + button('library-mod', 'Manage', '', data(item.id)) + '</div>').join('');
  const libraryPanel = panel('Saved presets', available ? 'Add a preset to the first empty slot in the selected save.'
    : 'Select a save with an empty Favorites slot to add a preset.',
  libraryRows || '<div class="empty"><h3>No JSON presets yet</h3><p>Paste an export or import a .json file to get started.</p></div>');

  let savePanel = '<p class="muted">Checking for Elden Ring saves…</p>';
  if (presetState) {
    if (!presetState.saves.length) {
      savePanel = '<p class="muted">No PC saves found. Create a character in Elden Ring or check the save folder in Settings.</p>';
    } else {
      const options = (selected ? '' : '<option value="" disabled selected>Choose the save you play</option>') +
        presetState.saves.map(save => '<option value="' + html(save.relative) + '"' +
          (selected?.relative === save.relative ? ' selected' : '') + '>' + html(save.label) + '</option>').join('');
      savePanel = '<label class="field">Elden Ring save<select data-favorites-save>' + options + '</select></label>' +
        (presetState.error ? '<p class="callout">' + html(presetState.error) + '</p>' : '');
    }
  }
  const rows = (presetState?.slots || []).map(slot => {
    const name = mod(slot.presetId)?.name;
    const filled = slot.status === 'occupied';
    const label = slot.status === 'reserved' ? 'Last-created appearance' : name ||
      (filled ? 'Saved appearance' : slot.status === 'empty' ? 'Empty' : 'Unavailable');
    const actions = filled ? '<div class="actions">' +
      button('favorite-replace', 'Replace', '', data(slot.slot) + (!entries.length || state.running ? ' disabled' : '')) +
      button('favorite-remove', 'Remove', 'danger subtle', data(slot.slot) + (state.running ? ' disabled' : '')) + '</div>' : '';
    const detail = slot.status === 'reserved' ? 'Reserved by Elden Ring' : slot.bodyType ? 'Body type ' + slot.bodyType :
      slot.status === 'unavailable' ? 'This slot uses an unrecognized record' : '';
    return '<div class="row"><span class="number">' + slot.slot + '</span><div class="item"><strong>' +
      html(label) + '</strong>' + (detail ? '<small>' + html(detail) + '</small>' : '') + '</div>' + actions + '</div>';
  }).join('');
  return title('Character appearance', 'Presets', 'Import slider JSON and manage Favorites in the save you play.') +
    '<div class="columns presets-columns"><div class="stack">' +
    panel('Import a preset', 'Copy JSON from Elden Sliders or download it from an Elden Bling Sliders share code.',
      body(input), button('import-preset-file', 'Import file', 'subtle')) + libraryPanel + '</div>' +
    panel('In-game Favorites', 'Close Elden Ring before editing. Ringward backs up the selected save before each change.',
      body(savePanel) + rows, button('favorites-refresh', 'Refresh', 'subtle')) + '</div>';
}

function nexus() {
  const account = state.account;
  const list = details ? panel(html(details.name), html(details.summary), details.files.map(file => {
    const installed = state.mods.some(item => item.nexus?.modId === details.id && item.nexus?.fileId === file.id);
    const archive = /\.(zip|7z|rar|csv)$/i.test(file.archive || '');
    const action = installed ? tag('Installed', 'ok') : archive
      ? button(account?.premium ? 'nexus-direct' : 'nexus-browser', account?.premium ? 'Download' : 'Get on Nexus', '', data(file.id))
      : tag('Extract and import folder');
    return '<div class="row">' + icon('file') + '<div class="item"><strong>' + html(file.name) + '</strong><small>' +
      html(file.category) + ' · ' + html(file.version) + ' · ' + html(file.archive) + '</small></div>' + action + '</div>';
  }).join('') || '<div class="empty">No files returned.</div>') : '';
  return '<div class="stack narrow">' + title('Downloads', 'Nexus Mods',
    'Browse Elden Ring mods on Nexus or look up a mod here and pick the file you want.') +
    (account ? '' : '<div class="callout">Connect your Nexus account to download directly into the library. ' +
      button('nav', 'Open settings', 'text', data('settings')) + '</div>') +
    (incoming.length ? '<div class="callout">A Nexus download is waiting. ' + button('nxm-incoming', 'Review download', 'text') + '</div>' : '') +
    panel('Find a mod', 'Paste a Nexus Mods link or enter its mod ID.', body(
      '<form class="inline-form" id="nexus-lookup"><input name="query" required placeholder="Nexus mod URL or ID" aria-label="Nexus mod URL or ID"><button type="submit">Find files</button></form>'
    ), button('open-external', 'Browse Nexus ' + icon('arrow'), 'subtle', data('nexus'))) + list +
    panel('Download link', 'Paste an nxm:// link from the Nexus download page.', body(
      '<form class="inline-form" id="nexus-link"><input name="link" type="password" required placeholder="nxm://eldenring/mods/…" aria-label="Nexus download link"><button class="primary" type="submit">Import</button></form>'
    )) + '</div>';
}

function saves() {
  const rows = state.backups.map(item => {
    const owner = state.profiles.find(p => p.id === item.profile);
    return '<div class="row">' + icon('save') + '<div class="item"><strong>' + html(item.reason) + ' · ' +
      html(new Date(item.time).toLocaleString()) + '</strong><small>' + item.count + ' files across Steam save folders' +
      (owner ? ' · ' + html(owner.name) : '') + '</small></div>' + button('backup-restore', 'Restore', '', data(item.id)) + '</div>';
  }).join('');
  return '<div class="narrow">' + title('Saves', 'Save backups', 'Take a snapshot of local Elden Ring saves and restore an earlier copy when the game is closed.') +
    panel('Snapshots', 'Automatic backups are controlled per profile.', rows ||
      '<div class="empty"><h3>No backups yet</h3><p>Create a snapshot before trying a new loadout.</p></div>',
      button('backup', icon('plus') + ' Back up now', 'primary')) +
    '<div class="metric">' + button('open-data', 'Open backups folder', 'text', data('backups')) + ' · ' +
    button('open-data', 'Open live saves', 'text', data('saves')) + '</div></div>';
}

function settings() {
  const paths = state.settings;
  const pathLine = (field, label, empty, secondary = '') => line(label, html(paths[field] || empty),
    button('choose-path', paths[field] ? 'Change' : 'Choose', '', data(field)) + secondary);
  const logoOptions = [[null, 'Use ME3 setting'], [true, 'Skip logos'], [false, 'Show logos']].map(([value, label]) =>
    '<option value="' + value + '"' + ((paths.skipLogos ?? null) === value ? ' selected' : '') + '>' + label + '</option>').join('');
  return '<div class="stack narrow">' + title('Preferences', 'Settings', 'Connect the game, its loader, and the tools used by your profiles.') +
    panel('Game & loader', 'Steam and ME3 paths are detected on first run.', body(
      pathLine('game', 'Elden Ring', 'Choose eldenring.exe') +
      pathLine('me3', 'Mod Engine 3' + (state.tools.me3Version ? ' · ' + html(state.tools.me3Version) : ''), 'Install a portable copy or choose me3.exe.',
        state.tools.me3 ? tag('Ready', 'ok') + button('me3-version', 'Check version', 'subtle')
          : button('install-me3', icon('download') + ' Install ME3', 'primary')) +
      pathLine('saves', 'Save folder', 'Choose the EldenRing folder that contains Steam account folders')
    ), button('detect', 'Auto-detect', 'subtle')) +
    panel('Game options', '', body(
      line('Startup logos', 'Applies to all ME3 launches. Steam launches use the game’s usual startup.',
        '<select aria-label="Startup logos" data-skip-logos>' + logoOptions + '</select>')
    )) +
    panel('Smithbox', 'Used to compare, merge, and build regulation.bin for the installed game version.', body(
      pathLine('smithbox', 'Smithbox', 'Install the verified release or select an extracted copy.',
        state.tools.smithbox ? tag('Ready', 'ok') : button('install-smithbox', icon('download') + ' Install 2.2.6', 'primary'))
    )) +
    panel('ReShade', 'Optional visual effects for offline play.', body(
      line('ReShade ' + html(state.reshadeVersion), state.tools.reshade ? 'Installed' : 'Setup available in the ReShade tab',
        button('nav', 'Open ReShade', '', data('reshade')))
    )) +
    panel('Nexus account', 'Personal API key for this development build. Windows encrypts the saved credential.', body(
      line(state.account ? html(state.account.name) : 'Account', state.account ? (state.account.premium ? 'Premium' : 'Standard') : 'Connect with your personal API key',
        state.account ? button('nexus-disconnect', 'Disconnect') : button('nexus-connect', 'Connect', 'primary')) +
      line('Mod Manager Download', 'Handle nxm:// links from your browser. This changes the Windows handler for NXM links.',
        state.protocol ? tag('Registered', 'ok') : button('nexus-register', 'Register links'))
    )) + '</div>';
}

function profileDialog(kind) {
  const active = profile();
  const editing = kind === 'settings';
  const value = editing ? active.name : kind === 'duplicate' ? active.name + ' copy' : '';
  const title = editing ? 'Profile settings' : kind === 'duplicate' ? 'Duplicate profile' : 'Create profile';
  dialog(title, '<label class="field">Profile name<input name="name" value="' + html(value) + '" required maxlength="120"></label>' +
    (editing ? '<ul class="checklist">' +
      check('isolated', 'Use a separate save file for this profile', active.isolated) +
      check('autoBackup', 'Back up saves before launch', active.autoBackup) +
      check('diagnostics', 'Enable ME3 diagnostics', active.diagnostics) + '</ul><div class="metric">' +
      button('profile-remove', 'Delete profile', 'text danger') + '</div>' : ''),
  editing ? 'Save' : 'Create', form => perform(async () => {
    await app.invoke('profile:edit', {
      action: kind, id: active.id, name: form.get('name'), isolated: form.has('isolated'),
      autoBackup: form.has('autoBackup'), diagnostics: form.has('diagnostics')
    });
    mergeReport = null;
    view = 'profile';
  }));
}

function setupMod(id) {
  const item = mod(id);
  const active = profile();
  const entry = active.mods.find(entry => entry.id === id);
  const options = '<option value="-1">No asset folder</option>' + item.candidates.map((candidate, index) =>
    '<option value="' + index + '" ' + (candidate === entry.root ? 'selected' : '') + '>' + html(candidate || 'Archive root') + '</option>').join('');
  const extras = item.candidates.map((root, index) => ({ root, index }))
    .filter(({ root }) => /(?:^|\/)(extras?|optional(?:[ _-][^/]*)?)(?:\/|$)/i.test(root));
  const overlays = extras.length ? '<p class="metric">Optional folders override matching files in the main folder in the order shown.</p><ul class="checklist">' +
    extras.map(({ root, index }) => check('overlay-' + index, html(root), entry.overlays?.includes(root))).join('') + '</ul>' : '';
  const natives = item.natives.length ? '<div class="callout">Native DLLs run code inside Elden Ring. Select only the DLLs specified by the mod author.</div>' +
    '<ul class="checklist">' + item.natives.map((file, index) =>
      check('dll-' + index, html(file), entry.natives.includes(file))).join('') + '</ul>' : '';
  const csvFiles = item.csvs || [];
  const csv = csvFiles.length ? '<h3>Smithbox CSV patches</h3><p class="metric">Keep a CSV checked to include it. Ringward automatically finds the group of game settings it belongs to.</p><ul class="checklist">' +
    csvFiles.map((file, index) => {
      const selected = entry.csv?.find(patch => patch.file === file);
      const table = selected?.table;
      return '<li>' + checkbox('csv-' + index, html(item.looseCsv ? item.archive : file), Boolean(selected)) +
        '<details class="csv-advanced" ' + (table ? 'open' : '') + '><summary>' +
        (table ? 'Manual table · ' + html(table) : 'Automatic table matching · Advanced') + '</summary>' +
        '<p class="metric">Choose a table manually if Ringward asks for help matching this CSV. A table is a group of related game settings.</p>' +
        '<label class="field">Smithbox table name<input name="table-' + index + '" value="' + html(table) +
        '" maxlength="100" placeholder="Automatic"></label></details></li>';
    }).join('') + '</ul>' : '';
  dialog(item.name, '<p class="muted">Choose the files this profile should use.</p>' + importNotes(item) +
    (item.candidates.length ? '<label class="field">Game asset folder<select name="root">' + options + '</select></label>' : '') +
    overlays + natives + csv + '<div class="actions metric">' +
    (item.configs.length ? button('config-list', 'Edit configs', 'subtle', data(id)) : '') +
    button('mod-folder', 'Open folder', 'subtle', data(id)) + button('mod-detach', 'Remove from profile', 'danger subtle', data(id)) +
    '</div>', 'Save', form => perform(async () => {
    const root = form.has('root') ? item.candidates[Number(form.get('root'))] ?? null : null;
    const dlls = item.natives.filter((_file, index) => form.has('dll-' + index));
    const overlays = extras.filter(extra => extra.root !== root && form.has('overlay-' + extra.index)).map(extra => extra.root);
    const csv = csvFiles.map((file, index) => ({ file, index })).filter(({ index }) => form.has('csv-' + index))
      .map(({ file, index }) => ({ file, table: String(form.get('table-' + index)).trim() }));
    await app.invoke('profile:mod', { action: 'configure', profile: active.id, modId: id, root, overlays, natives: dlls, csv });
    mergeReport = null;
  }));
}

function libraryMod(id) {
  const item = mod(id);
  dialog(item.name, importNotes(item) + '<label class="field">Display name<input name="name" required maxlength="120" value="' + html(item.name) +
    '"></label><div class="actions metric">' +
    (item.sliderSheets?.length ? button('view-sliders', 'View sliders', '', data(id)) : '') +
    (item.configs.length ? button('config-list', 'Edit configs', '', data(id)) : '') +
    button('mod-folder', 'Open folder', '', data(id)) + button('mod-remove', 'Delete from library', 'danger subtle', data(id)) +
    '</div>', 'Save', form => perform(() => app.invoke('mods:rename', id, form.get('name'))));
}

function viewSliders(id) {
  const item = mod(id);
  const sheets = item.sliderSheets || [];
  const open = index => perform(() => app.invoke('mods:slider-sheet', id, index));
  if (sheets.length === 1) return open(0);
  if (sheets.length > 1) {
    dialog('Character sliders', '<label class="field">Slider sheet<select name="sheet">' + sheets.map((file, index) =>
      '<option value="' + index + '">' + html(file) + '</option>').join('') + '</select></label>',
      'Open image', form => open(Number(form.get('sheet'))));
  }
}

async function applyPreset(id) {
  const item = mod(id);
  const saves = await perform(() => app.invoke('mods:appearance-saves'));
  if (!saves) return;
  if (!saves.length) {
    toast('Create a character and save in Elden Ring first, or check the save folder in Settings.', true);
    return;
  }
  const options = (saves.length > 1 ? '<option value="">Choose a save</option>' : '') +
    saves.map(save => '<option value="' + html(save.relative) + '">' + html(save.label) + '</option>').join('');
  dialog('Add ' + item.name + ' to Favorites',
    '<p>Close Elden Ring and select the save you plan to load. Ringward backs it up and adds the appearance to an empty Favorites slot.</p>' +
    '<label class="field">Elden Ring save<select name="save" required>' + options + '</select></label>' +
    '<p class="metric">Open Favorites in the character creator or at the Roundtable Hold mirror to use it. Set the character name, age category, voice, and musculature in game.</p>',
    'Back up & add Favorite', form => perform(() => app.invoke('mods:apply-appearance', id, form.get('save')), result =>
      result.already ? 'This appearance is already in Favorites.' : 'Appearance added to Favorites. Open the game’s appearance editor to use it.'));
}

async function changeFavorite(relative, work, success) {
  return perform(async () => {
    const result = await work();
    presetState = await app.invoke('presets:state', relative);
    return result;
  }, success);
}

const favoriteResult = result => result.already ? 'This appearance is already in slot ' + result.slot + '.'
  : 'Saved appearance in Favorites slot ' + result.slot + '.';

function addPresetFavorite(id) {
  const save = selectedPresetSave();
  if (!save) return;
  const item = mod(id);
  dialog('Add ' + item.name + ' to Favorites',
    '<p>Save <strong>' + html(item.name) + '</strong> to the first empty slot in <strong>' + html(save.label) +
    '</strong>. Then choose it under Favorites in Elden Ring’s appearance editor.</p>',
    'Back up & add', () => changeFavorite(save.relative, () => app.invoke('presets:apply', id, save.relative), favoriteResult));
}

function editPresetFavorite(id, remove) {
  const save = selectedPresetSave();
  const slot = presetState?.slots.find(slot => slot.slot === Number(id));
  if (!save || slot?.status !== 'occupied') return;
  const target = { slot: slot.slot, revision: slot.revision };
  const heading = (remove ? 'Remove' : 'Replace') + ' Favorites slot ' + slot.slot;
  const description = '<p>' + heading + ' in <strong>' + html(save.label) + '</strong>. Ringward will back up the save first.</p>';
  if (remove) {
    dialog(heading, description, 'Back up & remove', () => changeFavorite(save.relative,
      () => app.invoke('presets:remove', save.relative, target), 'Removed Favorite from slot ' + slot.slot + '.'));
    return;
  }
  const options = savedPresets().map(item => '<option value="' + html(item.id) + '">' + html(item.name) + '</option>').join('');
  dialog(heading, description + '<label class="field">Replacement preset<select name="preset" required>' +
    '<option value="" disabled selected>Choose a preset</option>' + options + '</select></label>',
    'Back up & replace', form => changeFavorite(save.relative,
      () => app.invoke('presets:apply', form.get('preset'), save.relative, target), favoriteResult));
}

function importNotes(item) {
  return item.warnings?.length ? '<div class="callout"><strong>Import notes</strong><ul>' +
    item.warnings.map(message => '<li>' + html(message) + '</li>').join('') + '</ul></div>' : '';
}

function configList(id) {
  const item = mod(id);
  dialog('Edit mod config', '<p>These settings apply wherever this installed mod is used.</p><label class="field">Config file<select name="index">' +
    item.configs.map((file, index) => '<option value="' + index + '">' + html(file) + '</option>').join('') +
    '</select></label>', 'Open', async form => {
    const file = item.configs[Number(form.get('index'))];
    const text = await perform(() => app.invoke('mods:config-read', id, file));
    if (text !== undefined) dialog(file, '<label class="field">UTF-8 config<textarea name="config" spellcheck="false">' +
      html(text) + '</textarea></label>', 'Save config', data => perform(() => app.invoke('mods:config-write', id, file, data.get('config')), 'Config saved.'));
  });
}

function showMerge(report, launch = false) {
  if (!report) return;
  const approved = mergeReport?.approved && mergeReport.fingerprint === report.fingerprint;
  mergeReport = { ...report, approved };
  const rows = report.conflicts.map(item => '<tr><td>' + html(item.table) + '</td><td>' + item.row +
    (item.index ? ' (' + (item.index + 1) + ')' : '') + '</td><td>' + html(item.field) + '</td><td>' +
    html(item.previous) + '<br><small>' + html(item.previousValue) + '</small></td><td>' + html(item.next) +
    '<br><small>' + html(item.nextValue) + '</small></td></tr>').join('');
  const sources = report.sources.map(item => '<li><strong>' + html(item.name) + '</strong> · ' + number(item.changes) +
    ' changes · ' + (item.table ? 'CSV → ' + html(item.table) +
      (item.retiredPadding ? ' · skipped ' + item.retiredPadding + ' retired zero-only padding columns' : '') :
      'regulation ' + html(item.version) + (item.version !== report.version ? ' (rebased)' : '')) + '</li>').join('');
  const count = report.conflictCount;
  const needsApproval = count && !approved;
  const conflicts = count ? '<div class="callout">' + number(count) +
    ' competing edits. When two mods change the same field, the mod farther down the load order wins.</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Table</th><th>Row</th><th>Field</th><th>Lower priority</th><th>Higher priority</th></tr></thead><tbody>' +
    rows + '</tbody></table></div>' + (count > report.conflicts.length ? '<p class="metric">Showing the first ' + report.conflicts.length + ' conflicts.</p>' : '')
    : '<p class="muted">No competing edits. Ringward can combine these changes automatically.</p>';
  const intro = launch
    ? 'Review the competing edits before Ringward builds one regulation.bin and starts the game.'
    : 'Build a copy of regulation.bin for this loadout. Launch offline also builds the file automatically before starting the game.';
  const label = launch ? 'Use load order & launch' : needsApproval ? 'Use load order & build' : 'Build regulation.bin';
  dialog('Regulation review', '<p>' + intro + '</p><p class="muted">Installed regulation ' +
    html(report.version) + '</p><ul>' + sources + '</ul>' + conflicts, label, async () => {
      mergeReport = { ...report, approved: true };
      if (launch) return startGame();
      const result = await perform(() => app.invoke('merge:build', state.active, report.fingerprint));
      if (result?.review) showMerge(result.review);
      if (result?.file) toast('Built regulation.bin and showed it in File Explorer.');
    });
}

async function startGame() {
  if (!state.tools.game || (!fullyVanilla() && !state.tools.me3)) {
    navigate('settings');
    toast(fullyVanilla() ? 'Choose Elden Ring before launching.' : 'Choose Elden Ring and ME3 before launching.', true);
    return;
  }
  if (state.visual && !state.tools.reshade) {
    navigate('reshade');
    toast('Install ReShade or turn it off before launching.', true);
    return;
  }
  if (state.visual && !state.tools.me3ReShade) {
    navigate('reshade');
    toast('ReShade requires ME3 0.13.0 or newer. Choose a compatible copy or unselect the preset.', true);
    return;
  }
  if (state.plan.regulations.length && !state.tools.smithbox) {
    navigate('settings');
    toast('Set up Smithbox to prepare this profile’s regulation file.', true);
    return;
  }
  const result = await perform(() => app.invoke('game:launch', state.active, mergeReport?.approved ? mergeReport.fingerprint : ''));
  if (result?.review) showMerge(result.review, true);
  if (result?.launched) toast('ME3 started. Check View log for game output.');
  if (result?.vanilla) toast('Asked Steam to start Elden Ring.');
}

function importResult(result) {
  if (!result) return;
  const imported = result.imported.filter(item => !item.duplicate);
  const duplicates = result.imported.filter(item => item.duplicate)
    .map(item => '“' + item.name + '” is already in the Mod library.');
  const warnings = imported.flatMap(item => item.warnings.map(message => item.name + ' — ' + message));
  const guides = imported.filter(item => item.sliderGuide);
  const presetImports = imported.filter(item => item.appearancePreset);
  const visualImports = imported.filter(item => item.reshadePreset);
  const modCount = imported.length - guides.length - presetImports.length - visualImports.length;
  const summary = modCount ? 'Imported ' + modCount + (modCount === 1 ? ' mod.' : ' mods.') : '';
  const guideSummary = guides.length ? 'Saved ' + guides.length + (guides.length === 1 ? ' slider guide' : ' slider guides') +
    ' to the Mod library. Choose View sliders and enter the values in Elden Ring.' : '';
  const presetSummary = presetImports.length ? 'Saved appearance preset' + (presetImports.length === 1 ? '' : 's') +
    ' in the Presets tab. Choose Add Favorite when Elden Ring is closed.' : '';
  const visualSummary = visualImports.length ? 'ReShade presets imported. Choose Select in the ReShade tab.' : '';
  if (visualImports.length && !modCount) {
    navigate('reshade');
  } else if (presetImports.length && !modCount) {
    navigate('presets');
  } else if (guides.length && !modCount) {
    listFilters.library = { query: '', status: 'all' };
    navigate('library');
  }
  const messages = [...result.errors, ...warnings, ...duplicates, summary, guideSummary, presetSummary, visualSummary].filter(Boolean);
  if (messages.length) toast(messages.join('\n'), result.errors.length > 0 || warnings.length > 0);
}

async function downloadNexus(request) {
  if (!state.account) {
    if (request.link) incoming.unshift(request.link);
    navigate('settings');
    toast('Connect your Nexus account to import this download.', true);
    return;
  }
  const item = await perform(() => app.invoke('nexus:download', request, state.active));
  if (item) importResult({ imported: [item], errors: [] });
}

async function getIncoming() {
  const links = await app.invoke('nexus:pending');
  if (!links.length) return;
  incoming.push(...links);
  navigate('nexus');
  toast('Nexus download received. Review it in Nexus Mods.');
}

const actions = {
  nav: navigate,
  'profile-create': () => profileDialog('create'),
  'profile-duplicate': () => profileDialog('duplicate'),
  'profile-settings': () => profileDialog('settings'),
  'profile-select': id => perform(async () => {
    await app.invoke('profile:edit', { action: 'select', id });
    if (id !== state.active) presetState = null;
    view = 'profile';
    mergeReport = null;
  }),
  'profile-remove': () => confirm('Delete profile', 'Delete ' + profile().name + ' and switch to Vanilla? Your library and backups will be kept.',
    'Delete profile', async () => {
      await app.invoke('profile:edit', { action: 'remove', id: state.active });
      mergeReport = null;
      presetState = null;
      view = 'profile';
    }, 'Profile deleted. Vanilla is selected.'),
  'import-zip': async () => importResult(await perform(() => app.invoke('mods:import', 'zip', state.active))),
  'import-folder': async () => importResult(await perform(() => app.invoke('mods:import', 'folder', state.active))),
  'import-preset-file': async () => importResult(await perform(() => app.invoke('mods:import', 'preset', state.active))),
  'import-reshade': async () => importResult(await perform(() => app.invoke('mods:import', 'reshade', state.active))),
  'install-reshade': () => perform(() => app.invoke('reshade:install'), 'ReShade and its shader collections are ready.'),
  'uninstall-reshade': () => confirm('Uninstall ReShade?', 'Ringward will remove its ReShade runtime and shader collections. Your imported presets and gameplay profile will be kept.',
    'Uninstall ReShade', async () => {
      try {
        await app.invoke('reshade:uninstall');
      } catch (error) {
        await refresh();
        throw error;
      }
    }, 'ReShade uninstalled.'),
  'reshade-me3': () => confirm('Use Ringward’s ME3?', 'Ringward will use its managed copy of ME3 0.13.0 for future launches.',
    'Install ME3 0.13.0', () => app.invoke('reshade:me3'), 'ME3 is ready for ReShade.'),
  'reshade-select': (id, trigger) => perform(() => app.invoke('reshade:select', id,
    mod(id).reshadePresets[Number(trigger.dataset.index)].file), 'ReShade preset selected for the next launch.'),
  'reshade-off': () => perform(() => app.invoke('reshade:select', null), 'ReShade is off for the next launch.'),
  'reshade-log': async () => {
    const log = await perform(() => app.invoke('game:log', 'reshade'));
    if (log !== undefined) dialog('ReShade log', log ? '<pre>' + html(log) + '</pre>' : '<p>No ReShade launch log is available.</p>');
  },
  'mod-add': id => profileAction('add', id),
  'move-up': id => profileAction('move', id, { direction: -1 }),
  'move-down': id => profileAction('move', id, { direction: 1 }),
  'mod-detach': id => { $('dialog').close(); return profileAction('detach', id); },
  'mod-setup': setupMod,
  'library-mod': libraryMod,
  'mod-folder': id => perform(() => app.invoke('mods:folder', id)),
  'view-sliders': viewSliders,
  'apply-preset': applyPreset,
  'favorites-refresh': () => loadPresetSlots(),
  'preset-add': addPresetFavorite,
  'favorite-replace': id => editPresetFavorite(id, false),
  'favorite-remove': id => editPresetFavorite(id, true),
  'mod-remove': id => confirm('Delete from library', 'Delete ' + mod(id).name + ' from Ringward and remove it from all profiles?',
    'Delete mod', () => app.invoke('mods:remove', id), 'Mod deleted from Ringward.'),
  'config-list': configList,
  'choose-path': id => perform(() => app.invoke('settings:pick', id)),
  detect: () => perform(() => app.invoke('settings:detect'), 'Detection complete.'),
  'me3-version': () => perform(() => app.invoke('settings:me3-version'), version => 'Installed ME3 version ' + version + '.'),
  'install-smithbox': () => perform(() => app.invoke('settings:smithbox'), 'Smithbox 2.2.6 is ready.'),
  'install-me3': () => perform(() => app.invoke('settings:me3-install'), 'ME3 is ready.'),
  'open-data': id => perform(() => app.invoke('open:data', id)),
  'open-external': id => perform(() => app.invoke('open:external', id)),
  backup: () => perform(() => app.invoke('saves:backup'), 'Save backup created.'),
  'backup-restore': id => confirm('Restore this backup?', 'Ringward will replace matching save files and make a safety copy of any files it overwrites.',
    'Restore saves', () => app.invoke('saves:restore', id), 'Save backup restored.'),
  'merge-review': async () => {
    if (!state.tools.smithbox) {
      navigate('settings');
      toast('Set up Smithbox to compare regulation files.', true);
      return;
    }
    showMerge(await perform(() => app.invoke('merge:review', state.active)));
  },
  'asset-conflicts': () => dialog('Asset overrides',
    '<p>The last enabled mod in your load order wins at each shared path.</p><div class="table-wrap"><table><thead><tr><th>File</th><th>Mods in order</th></tr></thead><tbody>' +
    state.plan.conflicts.map(([file, mods]) => '<tr><td>' + html(file) + '</td><td>' + html(mods.join(' → ')) + '</td></tr>').join('') +
    '</tbody></table></div>' + (state.plan.assetConflictCount > state.plan.conflicts.length ? '<p>Showing the first 300 paths.</p>' : '')),
  launch: startGame,
  'view-log': async () => {
    const log = await perform(() => app.invoke('game:log'));
    if (log !== undefined) dialog('ME3 launch log', log ? '<pre>' + html(log) + '</pre>' : '<p>No launch output yet.</p>');
  },
  'nexus-connect': () => dialog('Connect Nexus Mods',
    '<p>Copy your personal API key from ' + button('open-external', 'Nexus account settings', 'text', data('apiKey')) +
    '.</p><label class="field">Personal API key<input name="key" type="password" autocomplete="off" required></label>',
    'Connect', form => perform(() => app.invoke('nexus:connect', form.get('key')), 'Nexus account connected.')),
  'nexus-disconnect': () => perform(() => app.invoke('nexus:disconnect'), 'Nexus account disconnected.'),
  'nexus-register': () => confirm('Handle Nexus download links?', 'Windows will use Ringward for nxm:// links. You can change the handler again in Windows Default Apps.',
    'Register Ringward', () => app.invoke('nexus:register'), 'Nexus download links registered.'),
  'nexus-direct': id => downloadNexus({ modId: details.id, fileId: id }),
  'nexus-browser': id => perform(() => app.invoke('open:external', 'nexus-file', { modId: details.id, fileId: id })),
  'nxm-incoming': () => {
    if (!incoming.length) return;
    if (!state.account) {
      navigate('settings');
      toast('Connect your Nexus account first. Your download is waiting in Nexus Mods.');
      return;
    }
    dialog('Import Nexus download', '<p>Download this file into Ringward and add it to <strong>' + html(profile().name) + '</strong>?</p>',
      'Download', async () => {
        const link = incoming.shift();
        await downloadNexus({ link });
      });
  },
  'close-dialog': () => $('dialog').close()
};

function profileAction(action, id, extra = {}) {
  mergeReport = null;
  return perform(() => app.invoke('profile:mod', { action, profile: state.active, modId: id, ...extra }));
}

document.addEventListener('click', event => {
  const target = event.target.closest('button[data-action]');
  if (!target || loading) return;
  actions[target.dataset.action]?.(target.dataset.id, target);
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-skip-logos]')) {
    if (loading) render();
    else perform(() => app.invoke('settings:skip-logos', JSON.parse(event.target.value)), 'Startup logo preference saved.');
    return;
  }
  if (event.target.matches('[data-favorites-save]')) {
    if (loading) render();
    else loadPresetSlots(event.target.value);
    return;
  }
  if (event.target.matches('[data-mod-status]')) {
    listFilters[view].status = event.target.value;
    filterMods();
    return;
  }
  if (event.target.dataset.toggle) {
    if (loading) render();
    else profileAction('toggle', event.target.dataset.toggle, { enabled: event.target.checked });
  }
});
document.addEventListener('input', event => {
  if (event.target.matches('[data-preset-draft]')) {
    presetDraft = event.target.value;
    return;
  }
  if (!event.target.matches('[data-mod-search]')) return;
  listFilters[view].query = event.target.value;
  filterMods();
});
document.addEventListener('submit', event => {
  event.preventDefault();
  if (loading) return;
  const form = new FormData(event.target);
  if (event.target.id === 'dialog-form') {
    const action = modalAction;
    $('dialog').close();
    action?.(form);
  } else if (event.target.id === 'nexus-lookup') {
    perform(async () => { details = await app.invoke('nexus:mod', form.get('query')); });
  } else if (event.target.id === 'nexus-link') {
    downloadNexus({ link: form.get('link') });
  } else if (event.target.id === 'paste-preset') {
    perform(async () => {
      const result = await app.invoke('presets:paste', form.get('json'));
      presetDraft = '';
      presetState = await app.invoke('presets:state', presetState?.selected);
      return result;
    }, result => result.duplicate ? '“' + result.name + '” is already saved in Presets.'
      : 'Saved “' + result.name + '”. Choose Add Favorite to put it in the selected save.');
  }
});
function clearLoadoutDrop() {
  dropRow?.classList.remove('drop-before', 'drop-after');
  dropRow = null;
}

function endLoadoutDrag() {
  clearLoadoutDrop();
  draggedRow?.classList.remove('dragging');
  draggedRow = null;
}

function dropAfter(event, row) {
  const bounds = row.getBoundingClientRect();
  return event.clientY >= bounds.top + bounds.height / 2;
}

document.addEventListener('dragstart', event => {
  const handle = event.target.closest('.drag-handle');
  if (!handle) return;
  if (loading || !handle.draggable) return event.preventDefault();
  draggedRow = handle.closest('[data-loadout-mod]');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(LOADOUT_DRAG, draggedRow.dataset.loadoutMod);
  draggedRow.classList.add('dragging');
});
document.addEventListener('dragend', endLoadoutDrag);
document.addEventListener('dragover', event => {
  if (draggedRow && event.dataTransfer.types.includes(LOADOUT_DRAG)) {
    const row = event.target.closest('[data-loadout-mod]');
    clearLoadoutDrop();
    if (!row || row === draggedRow || loading) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dropRow = row;
    dropRow.classList.add(dropAfter(event, row) ? 'drop-after' : 'drop-before');
    return;
  }
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  $('dropzone')?.classList.add('active');
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) {
    clearLoadoutDrop();
    $('dropzone')?.classList.remove('active');
  }
});
document.addEventListener('drop', async event => {
  event.preventDefault();
  if (draggedRow && event.dataTransfer.types.includes(LOADOUT_DRAG)) {
    const row = event.target.closest('[data-loadout-mod]');
    const id = draggedRow.dataset.loadoutMod;
    endLoadoutDrag();
    if (row && row.dataset.loadoutMod !== id && event.dataTransfer.getData(LOADOUT_DRAG) === id) {
      await profileAction('reorder', id, { targetId: row.dataset.loadoutMod, after: dropAfter(event, row) });
    }
    return;
  }
  $('dropzone')?.classList.remove('active');
  if (event.dataTransfer.files.length && state) {
    importResult(await perform(() => app.dropped([...event.dataTransfer.files], state.active)));
  }
});
if (app) {
  $('content').innerHTML = '<div class="loading">Opening Ringward…</div>';
  app.onProgress(data => {
    $('operation').hidden = !data;
    if (!data) return;
    $('operation-text').textContent = data.message;
    const progress = $('operation').querySelector('progress');
    if (data.fraction === null) progress.removeAttribute('value');
    else progress.value = data.fraction;
  });
  app.onIncoming(() => { if (state) getIncoming().catch(error => toast(error.message, true)); });
  app.onGameEnded(code => {
    refresh().catch(error => toast(error.message, true));
    if (code) toast('ME3 exited with code ' + code + '. Open View log for details.', true);
  });
  refresh().then(getIncoming).catch(error => { $('content').textContent = error.message; });
}
