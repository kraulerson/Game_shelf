// Replace emoji stubs with actual SVG icons — each launcher's press kit provides official assets.
const LAUNCHER_ICONS = {
  steam: '\u{1F3AE}',
  ea: '\u{1F3AE}',
  ubisoft: '\u{1F3AE}',
  epic: '\u{1F3AE}',
  humble: '\u{1F4E6}',
  itchio: '\u{1F579}\uFE0F',
  gog: '\u{1F3AE}',
  battlenet: '\u{2694}\uFE0F',
  xbox: '\u{1F3AE}',
};

export function getLauncherIcon(launcherId) {
  return LAUNCHER_ICONS[launcherId] || '\u{1F3AE}';
}

export default LAUNCHER_ICONS;
