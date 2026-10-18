/* Apply saved appearance before the stylesheets load to avoid a theme flash. */
(() => {
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const mode = read('cue-rights-theme');
  const preference = ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = preference === 'system' ? (dark ? 'dark' : 'light') : preference;

  const surfaces = ['liquid-glass', 'studio', 'midnight', 'graphite', 'daylight', 'obsidian', 'frost', 'aurora', 'parchment'];
  const savedSurface = read('cue-rights-surface');
  document.documentElement.dataset.surface = surfaces.includes(savedSurface) ? savedSurface : 'studio';

  const colors = { violet: [272, 81], indigo: [239, 72], cyan: [190, 72], blue: [212, 77], emerald: [157, 67], lime: [104, 63], amber: [40, 77], coral: [15, 76], rose: [345, 78], pink: [317, 79] };
  const savedAccent = read('cue-rights-accent') || 'violet';
  const custom = /^custom:(\d{1,3})$/.exec(savedAccent);
  const validCustom = custom && Number(custom[1]) <= 359;
  const accent = colors[savedAccent] ? savedAccent : validCustom ? 'custom' : 'violet';
  const [hue, saturation] = accent === 'custom' ? [Number(custom[1]), 80] : colors[accent];
  document.documentElement.dataset.accent = accent;
  document.documentElement.style.setProperty('--appearance-hue', String(hue));
  document.documentElement.style.setProperty('--appearance-saturation', `${saturation}%`);
  document.documentElement.style.setProperty('--appearance-accent', `hsl(${hue} ${saturation}% 56%)`);
})();
