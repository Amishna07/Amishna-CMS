/* Browser-only workspace appearance preferences. No CMS records are changed here. */
(() => {
  'use strict';

  const SURFACE_KEY = 'cue-rights-surface';
  const ACCENT_KEY = 'cue-rights-accent';
  const surfaces = [
    { id: 'liquid-glass', name: 'Liquid Glass', description: 'Translucent layered glass over a living accent field', badge: 'NEW' },
    { id: 'studio', name: 'Studio', description: 'High contrast with brand-tinted surfaces' },
    { id: 'midnight', name: 'Midnight', description: 'Cool obsidian with deep blue undertones' },
    { id: 'graphite', name: 'Graphite', description: 'Zero-saturation slate and pure blacks' },
    { id: 'daylight', name: 'Daylight', description: 'Crisp, airy surfaces for bright rooms' },
    { id: 'obsidian', name: 'Obsidian', description: 'Deep, quiet surfaces with sharp edges' },
    { id: 'frost', name: 'Frost', description: 'Soft glass and cool winter light' },
    { id: 'aurora', name: 'Aurora', description: 'Gentle color drifting through the workspace' },
    { id: 'parchment', name: 'Parchment', description: 'Warm paper and a relaxed reading surface' }
  ];
  const accents = [
    { id: 'violet', name: 'Violet', hue: 272, saturation: 81 },
    { id: 'indigo', name: 'Indigo', hue: 239, saturation: 72 },
    { id: 'cyan', name: 'Cyan', hue: 190, saturation: 72 },
    { id: 'blue', name: 'Blue', hue: 212, saturation: 77 },
    { id: 'emerald', name: 'Emerald', hue: 157, saturation: 67 },
    { id: 'lime', name: 'Lime', hue: 104, saturation: 63 },
    { id: 'amber', name: 'Amber', hue: 40, saturation: 77 },
    { id: 'coral', name: 'Coral', hue: 15, saturation: 76 },
    { id: 'rose', name: 'Rose', hue: 345, saturation: 78 },
    { id: 'pink', name: 'Pink', hue: 317, saturation: 79 }
  ];
  const defaultSurface = 'studio';
  const defaultAccent = 'violet';
  const root = document.getElementById('appearance-studio-root');
  if (!root) return;

  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Appearance stays usable without storage. */ }
  }
  function validSurface(value) {
    return surfaces.some(surface => surface.id === value) ? value : defaultSurface;
  }
  function validAccent(value) {
    if (accents.some(accent => accent.id === value)) return value;
    const custom = /^custom:(\d{1,3})$/.exec(value || '');
    return custom && Number(custom[1]) <= 359 ? value : defaultAccent;
  }
  let surface = validSurface(read(SURFACE_KEY, defaultSurface));
  let accent = validAccent(read(ACCENT_KEY, defaultAccent));
  let expanded = false;
  let trigger = null;
  let getMode = () => read('cue-rights-theme', 'system');
  let setMode = () => {};

  const glyphs = {
    sparkle: '<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z M19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7L19 17z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8 M12 17v4"/>',
    reset: '<path d="M4 10a8 8 0 1 1-.1 4 M4 4v6h6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M5 5l14 14 M19 5 5 19"/>',
    check: '<path d="m5 12 4 4L19 6"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyphs[name]}</svg>`;
  function activeAccent() {
    if (accent.startsWith('custom:')) return { id: 'custom', name: 'Custom', hue: Number(accent.slice(7)), saturation: 80 };
    return accents.find(item => item.id === accent) || accents[0];
  }
  function apply() {
    const color = activeAccent();
    document.documentElement.dataset.surface = surface;
    document.documentElement.dataset.accent = color.id;
    document.documentElement.style.setProperty('--appearance-hue', String(color.hue));
    document.documentElement.style.setProperty('--appearance-saturation', `${color.saturation}%`);
    document.documentElement.style.setProperty('--appearance-accent', `hsl(${color.hue} ${color.saturation}% 56%)`);
  }
  function modeButton(id, label, glyph) {
    return `<button type="button" class="as-mode-button" data-as-mode="${id}" aria-pressed="false">${icon(glyph)}<span>${label}</span></button>`;
  }
  function preview() {
    return '<span class="as-preview" aria-hidden="true"><span class="as-preview-rail"><i></i><i></i><i></i></span><span class="as-preview-main"><i class="as-preview-top"></i><span class="as-preview-row"><i></i><span><b></b><b></b></span><em></em></span></span></span>';
  }
  function surfaceCard(item) {
    return `<button type="button" class="as-surface-card" data-as-surface="${item.id}" aria-pressed="false">${preview()}<span class="as-card-name">${item.name}${item.badge ? `<span class="as-card-badge">${item.badge}</span>` : ''}</span><span class="as-card-description">${item.description}</span><span class="as-card-check" aria-hidden="true">${icon('check')}</span></button>`;
  }
  function render() {
    root.innerHTML = `<section class="appearance-studio" role="dialog" aria-label="Appearance Studio" aria-modal="false" tabindex="-1">
      <header class="as-header"><span class="as-symbol">${icon('sparkle')}</span><span class="as-title"><strong>Appearance Studio</strong><small>Instant workspace theme</small></span><button type="button" class="as-reset" data-as-reset>${icon('reset')}<span>Reset</span></button><button type="button" class="as-close" data-as-close aria-label="Close Appearance Studio">${icon('close')}</button></header>
      <div class="as-body">
        <section class="as-section" aria-labelledby="as-mode-heading"><div class="as-section-head"><h2 id="as-mode-heading">Color mode</h2><span data-as-mode-label></span></div><div class="as-mode-group" role="group" aria-label="Color mode">${modeButton('light', 'Light', 'sun')}${modeButton('dark', 'Dark', 'moon')}${modeButton('system', 'System', 'screen')}</div></section>
        <section class="as-section" aria-labelledby="as-surface-heading"><div class="as-section-head"><h2 id="as-surface-heading">Surface preset</h2><span data-as-surface-label></span></div><div class="as-surface-grid">${surfaces.slice(0, 4).map(surfaceCard).join('')}</div><button type="button" class="as-more" data-as-more aria-expanded="false" aria-controls="as-more-grid"><span class="as-more-label"><strong>More surfaces</strong><small>Daylight, Obsidian, Frost, Aurora, Parchment</small></span>${icon('down')}</button><div class="as-more-grid as-surface-grid" id="as-more-grid" hidden>${surfaces.slice(4).map(surfaceCard).join('')}</div></section>
        <section class="as-section as-accent-section" aria-labelledby="as-accent-heading"><div class="as-section-head"><h2 id="as-accent-heading">Accent color</h2><span class="as-accent-label" data-as-accent-label></span></div><div class="as-swatch-grid" role="group" aria-label="Accent color">${accents.map(item => `<button type="button" class="as-swatch" data-as-accent="${item.id}" aria-label="${item.name}" aria-pressed="false" style="--swatch-color:hsl(${item.hue} ${item.saturation}% 54%)">${icon('check')}</button>`).join('')}</div><div class="as-spectrum"><div class="as-spectrum-heading"><label for="as-hue">Custom Spectrum</label><output class="as-degree" for="as-hue"></output></div><input id="as-hue" type="range" min="0" max="359" step="1" aria-label="Custom accent hue"></div></section>
      </div><p class="as-footer">Your appearance is saved on this browser.</p>
    </section>`;
    sync();
  }
  function sync() {
    const mode = getMode();
    const currentSurface = surfaces.find(item => item.id === surface);
    const color = activeAccent();
    const modeLabel = root.querySelector('[data-as-mode-label]');
    if (modeLabel) modeLabel.textContent = `${mode[0].toUpperCase()}${mode.slice(1)} Mode`;
    const surfaceLabel = root.querySelector('[data-as-surface-label]');
    if (surfaceLabel) surfaceLabel.textContent = currentSurface.name;
    const accentLabel = root.querySelector('[data-as-accent-label]');
    if (accentLabel) accentLabel.innerHTML = `<span class="as-accent-dot" style="--swatch-color:hsl(${color.hue} ${color.saturation}% 54%)"></span>${color.name}`;
    root.querySelectorAll('[data-as-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.asMode === mode)));
    root.querySelectorAll('[data-as-surface]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.asSurface === surface)));
    root.querySelectorAll('[data-as-accent]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.asAccent === accent)));
    const slider = root.querySelector('#as-hue');
    if (slider) slider.value = String(color.hue);
    const degree = root.querySelector('.as-degree');
    if (degree) degree.textContent = `${color.hue}°`;
    const more = root.querySelector('[data-as-more]');
    if (more) more.setAttribute('aria-expanded', String(expanded));
    const moreGrid = root.querySelector('#as-more-grid');
    if (moreGrid) moreGrid.hidden = !expanded;
    document.querySelectorAll('[data-action="appearance-studio"]').forEach(button => button.setAttribute('aria-expanded', String(!root.hidden)));
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    root.innerHTML = '';
    document.querySelectorAll('[data-action="appearance-studio"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    const previous = trigger;
    trigger = null;
    if (previous?.isConnected) previous.focus();
  }
  function open(button) {
    if (!root.hidden) { close(); return; }
    trigger = button || document.activeElement;
    root.hidden = false;
    render();
    root.querySelector('.appearance-studio')?.focus();
  }
  function chooseSurface(next) {
    surface = validSurface(next);
    write(SURFACE_KEY, surface);
    apply();
    sync();
  }
  function chooseAccent(next) {
    accent = validAccent(next);
    write(ACCENT_KEY, accent);
    apply();
    sync();
  }
  function reset() {
    surface = defaultSurface;
    accent = defaultAccent;
    expanded = false;
    write(SURFACE_KEY, surface);
    write(ACCENT_KEY, accent);
    apply();
    setMode('system');
    sync();
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-as-close')) close();
    else if (button.hasAttribute('data-as-reset')) reset();
    else if (button.hasAttribute('data-as-more')) { expanded = !expanded; sync(); }
    else if (button.dataset.asMode) { setMode(button.dataset.asMode); sync(); }
    else if (button.dataset.asSurface) chooseSurface(button.dataset.asSurface);
    else if (button.dataset.asAccent) chooseAccent(button.dataset.asAccent);
  });
  root.addEventListener('input', event => {
    if (event.target.id !== 'as-hue') return;
    chooseAccent(`custom:${event.target.value}`);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !root.hidden) { event.preventDefault(); close(); }
  });
  document.addEventListener('pointerdown', event => {
    if (root.hidden || root.contains(event.target) || event.target.closest('[data-action="appearance-studio"]')) return;
    close();
  });
  apply();
  window.AmishnaAppearance = { configure(options) { getMode = options.getMode; setMode = options.setMode; sync(); }, open, close, sync };
})();
