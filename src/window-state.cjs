function restoreWindowState(state, screen) {
  const bounds = state?.bounds;
  const valid = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(value =>
    Number.isInteger(value) && Math.abs(value) <= 0x7fffffff) && bounds.width > 0 && bounds.height > 0;
  const { workArea } = valid ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const minWidth = Math.min(830, workArea.width);
  const minHeight = Math.min(650, workArea.height);
  const width = clamp(valid ? bounds.width : 1330, minWidth, workArea.width);
  const height = clamp(valid ? bounds.height : 910, minHeight, workArea.height);
  const options = { width, height, minWidth, minHeight };
  if (valid) {
    options.x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - width);
    options.y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);
  }
  return { options, maximized: Boolean(valid) && state.maximized === true };
}

module.exports = { restoreWindowState };
