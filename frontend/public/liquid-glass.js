/* Optional material feedback. No rendering, workspace state, or network access. */
(function (global) {
  'use strict';
  if (global.AmishnaGlass) return;

  const document = global.document;
  const finePointer = global.matchMedia?.('(hover: hover) and (pointer: fine)');
  const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
  const animations = new Set(), ghosts = new Set();
  let frame = 0, active = null, pending = null, listening = false, destroyed = false;

  function clearSurface() {
    if (!active) return;
    active.removeAttribute('data-glass-active');
    active.style.removeProperty('--glass-pointer-x');
    active.style.removeProperty('--glass-pointer-y');
    active = null;
  }

  function reset() {
    if (frame) global.cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    clearSurface();
  }

  function paint() {
    frame = 0;
    const next = pending;
    pending = null;
    if (active !== next?.surface) clearSurface();
    if (!next?.surface?.isConnected || document.hidden) return;
    const rect = next.surface.getBoundingClientRect();
    // Opt in individual controls or small panels, never the entire workspace.
    if (!rect.width || !rect.height || rect.width > 960 || rect.height > 900) return;
    active = next.surface;
    active.style.setProperty('--glass-pointer-x', Math.max(0, Math.min(rect.width, next.x - rect.left)).toFixed(1) + 'px');
    active.style.setProperty('--glass-pointer-y', Math.max(0, Math.min(rect.height, next.y - rect.top)).toFixed(1) + 'px');
    active.setAttribute('data-glass-active', 'true');
  }

  function pointerMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse') { reset(); return; }
    const surface = event.target?.closest?.('[data-glass-light]');
    if (!surface && !active && !pending) return;
    pending = surface ? { surface, x: event.clientX, y: event.clientY } : null;
    if (!frame) frame = global.requestAnimationFrame(paint);
  }

  function removeGhosts() {
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }

  function cancelMotion() {
    for (const animation of animations) animation.cancel();
    animations.clear();
    removeGhosts();
  }

  function syncPointer() {
    const enabled = !destroyed && !document.hidden && !!finePointer?.matches && !reducedMotion?.matches;
    if (enabled !== listening) {
      document[enabled ? 'addEventListener' : 'removeEventListener']('pointermove', pointerMove, { passive: true });
      listening = enabled;
    }
    if (!enabled) reset();
    if (reducedMotion?.matches || document.hidden) cancelMotion();
  }

  function motionAllowed(element) {
    return !destroyed && !document.hidden && !reducedMotion?.matches && element?.isConnected && typeof element.animate === 'function';
  }

  function animate(element, keyframes, options, done = () => {}) {
    const animation = element.animate(keyframes, options);
    animations.add(animation);
    const finish = () => { animations.delete(animation); done(); };
    animation.finished.then(finish, finish);
    return animation;
  }

  function enterModal(element) {
    removeGhosts();
    if (!motionAllowed(element)) return;
    animate(element, [
      { opacity: 0, transform: 'translateY(8px) scale(.988)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function exitModal(element) {
    if (!motionAllowed(element)) return;
    removeGhosts();
    const rect = element.getBoundingClientRect(), style = global.getComputedStyle(element);
    const ghost = element.cloneNode(true);
    // Never let a presentation snapshot count as a live dialog or form.
    for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
      node.removeAttribute('id');
      node.removeAttribute('autofocus');
      node.removeAttribute('name');
      node.removeAttribute('role');
      node.removeAttribute('aria-modal');
      node.classList.remove('modal');
      for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
    }
    ghost.classList.add('glass-modal-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', height: rect.height + 'px', maxHeight: 'none',
      margin: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '60',
      background: style.background, border: style.border, borderRadius: style.borderRadius,
      boxShadow: style.boxShadow, color: style.color, font: style.font,
    });
    document.body.append(ghost);
    ghost.scrollTop = element.scrollTop;
    ghosts.add(ghost);
    animate(ghost, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(5px) scale(.99)' },
    ], { duration: 130, easing: 'cubic-bezier(.4,0,1,1)' }, () => { ghost.remove(); ghosts.delete(ghost); });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    syncPointer();
    cancelMotion();
    finePointer?.removeEventListener('change', syncPointer);
    reducedMotion?.removeEventListener('change', syncPointer);
    document.removeEventListener('visibilitychange', syncPointer);
  }

  finePointer?.addEventListener('change', syncPointer);
  reducedMotion?.addEventListener('change', syncPointer);
  document.addEventListener('visibilitychange', syncPointer);
  syncPointer();
  global.AmishnaGlass = Object.freeze({ enterModal, exitModal, reset, destroy });
})(window);
