/* Keyboard focus for workspace dialogs and the responsive navigation drawer. */
(function (global) {
  'use strict';
  const narrow = global.matchMedia('(max-width: 760px)');
  let drawerTrigger = null, previousOverflow = null;
  const dialog = () => document.querySelector('#modal-root .modal');
  const sidebar = () => document.querySelector('#workspace-navigation');
  const drawerOpen = () => narrow.matches && !!sidebar()?.classList.contains('open');

  function focusable(container) {
    if (!container) return [];
    return [...container.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
        !element.closest('[inert]') && element.getClientRects().length &&
        global.getComputedStyle(element).visibility !== 'hidden');
  }
  function lockScroll(locked) {
    if (locked && previousOverflow === null) {
      previousOverflow = {value: document.body.style.getPropertyValue('overflow'), priority: document.body.style.getPropertyPriority('overflow')};
      document.body.style.setProperty('overflow', 'hidden', 'important');
    } else if (!locked && previousOverflow !== null) {
      if (previousOverflow.value) document.body.style.setProperty('overflow', previousOverflow.value, previousOverflow.priority);
      else document.body.style.removeProperty('overflow');
      previousOverflow = null;
    }
  }
  function syncNavigation() {
    const navigation = sidebar(), open = drawerOpen();
    if (!navigation) return;
    navigation.inert = narrow.matches && !open;
    document.querySelector('.mobile-menu')?.setAttribute('aria-expanded', String(open));
    document.querySelector('.navigation-backdrop')?.classList.toggle('visible', open);
    const main = document.querySelector('#app .main');
    if (main) main.inert = open;
    const sync = document.getElementById('sync-root');
    if (sync) sync.inert = open || !!dialog();
    lockScroll(open || !!dialog());
  }
  function closeNavigation(restoreFocus = false) {
    const wasOpen = drawerOpen(), trigger = drawerTrigger;
    sidebar()?.classList.remove('open');
    drawerTrigger = null;
    syncNavigation();
    if (wasOpen && restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function toggleNavigation() {
    if (!narrow.matches) return;
    if (drawerOpen()) return closeNavigation(true);
    drawerTrigger = document.activeElement;
    sidebar()?.classList.add('open');
    syncNavigation();
    focusable(sidebar())[0]?.focus();
  }
  function setModalOpen(open) {
    if (open) closeNavigation();
    const app = document.getElementById('app');
    if (app) app.inert = open;
    syncNavigation();
  }
  function focusDialog(modal) {
    if (!modal?.isConnected || modal !== dialog()) return;
    const controls = focusable(modal);
    const target = controls.find(element => element.matches('input,select,textarea')) || controls[0] || modal;
    target.focus({preventScroll: true});
  }
  function focusPage() {
    const heading = document.querySelector('#page h1');
    if (!heading || dialog()) return;
    heading.tabIndex = -1;
    heading.focus({preventScroll: true});
  }
  document.addEventListener('keydown', event => {
    const modal = dialog();
    if (event.key === 'Escape' && !modal && drawerOpen()) {
      event.preventDefault();
      closeNavigation(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const container = modal || (drawerOpen() ? sidebar() : null);
    if (!container) return;
    const controls = focusable(container), index = controls.indexOf(document.activeElement);
    if (!controls.length) { event.preventDefault(); container.focus(); return; }
    if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  });
  narrow.addEventListener('change', () => {
    const active = document.activeElement;
    closeNavigation();
    if (narrow.matches && sidebar()?.contains(active)) document.querySelector('.mobile-menu')?.focus();
    else if (!narrow.matches && active?.matches('.mobile-menu,.navigation-close')) focusable(sidebar())[0]?.focus();
  });
  global.AmishnaAccessibility = Object.freeze({closeNavigation, toggleNavigation, setModalOpen, focusDialog, focusPage});
})(window);
