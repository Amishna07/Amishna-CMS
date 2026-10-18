'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/workspace-accessibility.js'), 'utf8');

function fixture() {
  const events = {}, mediaEvents = {};
  let document;
  const element = (tag, options = {}) => {
    const classes = new Set(), attributes = {};
    const result = {tag, tabIndex: 0, visible: true, disabled: false, inert: false, isConnected: true, children: [], ...options};
    result.classList = {contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name)};
    result.setAttribute = (name, value) => { attributes[name] = value; };
    result.getAttribute = name => attributes[name];
    result.querySelectorAll = () => result.children;
    result.getClientRects = () => result.visible ? [{}] : [];
    result.matches = selector => selector === ':disabled' ? result.disabled : selector.split(',').some(name => name.trim() === result.tag || classes.has(name.trim().slice(1)));
    result.closest = () => result.inert ? result : null;
    result.contains = child => result.children.includes(child);
    result.focus = () => { if (!result.inert && result.visible && !result.disabled) document.activeElement = result; };
    return result;
  };
  const main = element('main'), app = element('div'), sync = element('div'), sidebar = element('aside');
  const menu = element('button'), close = element('button'), brand = element('button'), last = element('button');
  menu.classList.add('mobile-menu'); close.classList.add('navigation-close');
  sidebar.children = [close, brand, last];
  const backdrop = element('button'), heading = element('h1');
  let modal = null;
  const media = {matches:true,addEventListener:(name, callback)=>{mediaEvents[name]=callback;}};
  const selectors = {'#workspace-navigation':sidebar,'.mobile-menu':menu,'.navigation-backdrop':backdrop,'#app .main':main,'#page h1':heading};
  const style = {overflow:'clip', priority:'',getPropertyValue(){return this.overflow;},getPropertyPriority(){return this.priority;},setProperty(name,value,priority=''){this.overflow=value;this.priority=priority;},removeProperty(){this.overflow='';this.priority='';}};
  document = {body:{style},activeElement:menu,
    querySelector:selector=>selector==='#modal-root .modal'?modal:selectors[selector],
    getElementById:id=>({app,'sync-root':sync}[id]),
    addEventListener:(name,callback)=>{events[name]=callback;}};
  const context = {document,matchMedia:()=>media,getComputedStyle:element=>({visibility:element.visibility||'visible'})};
  context.window = context;
  vm.runInNewContext(source, context);
  function key(key, shiftKey = false) {
    const event = {key,shiftKey,prevented:false,preventDefault(){this.prevented=true;}};
    events.keydown(event);
    return event;
  }
  return {api:context.AmishnaAccessibility, document, element, main, app, sync, sidebar, menu, close, brand, last, heading, backdrop, media, mediaEvents, key, setModal:value=>{modal=value;}};
}

test('closed mobile navigation is inert; opening announces its state and focuses its close control', () => {
  const f = fixture();
  f.api.closeNavigation();
  assert.equal(f.sidebar.inert, true);
  assert.equal(f.menu.getAttribute('aria-expanded'), 'false');
  f.api.toggleNavigation();
  assert.equal(f.sidebar.inert, false);
  assert.equal(f.menu.getAttribute('aria-expanded'), 'true');
  assert.equal(f.main.inert, true);
  assert.equal(f.sync.inert, true);
  assert.equal(f.document.activeElement, f.close);
  assert.equal(f.backdrop.classList.contains('visible'), true);
  assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.document.body.style.priority, 'important');
});

test('navigation wraps Tab in both directions and Escape restores focus and prior scrolling', () => {
  const f = fixture(); f.api.toggleNavigation();
  f.last.focus(); assert.equal(f.key('Tab').prevented, true); assert.equal(f.document.activeElement, f.close);
  assert.equal(f.key('Tab', true).prevented, true); assert.equal(f.document.activeElement, f.last);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.document.activeElement, f.menu);
  assert.equal(f.main.inert, false); assert.equal(f.sidebar.inert, true);
  assert.equal(f.document.body.style.overflow, 'clip');
  assert.equal(f.document.body.style.priority, '');
});

test('dialog focus skips hidden, disabled and negative-tabindex inputs and makes the background inert', () => {
  const f = fixture(), modal = f.element('section', {tabIndex:-1});
  const close = f.element('button'), hidden = f.element('input', {visible:false});
  const disabled = f.element('input', {disabled:true}), untabbable = f.element('input', {tabIndex:-1});
  const input = f.element('input'), submit = f.element('button');
  modal.children = [close, hidden, disabled, untabbable, input, submit];
  f.setModal(modal); f.api.setModalOpen(true); f.api.focusDialog(modal);
  assert.equal(f.document.activeElement, input); assert.equal(f.app.inert, true);
  submit.focus(); f.key('Tab'); assert.equal(f.document.activeElement, close);
  f.key('Tab', true); assert.equal(f.document.activeElement, submit);
  f.setModal(null); f.api.setModalOpen(false);
  assert.equal(f.app.inert, false); assert.equal(f.sync.inert, false);
  assert.equal(f.document.body.style.overflow, 'clip');
});

test('dialogs recover focus from outside and retain focus when every control is disabled', () => {
  const f = fixture(), modal = f.element('section', {tabIndex:-1}), button = f.element('button');
  modal.children = [button]; f.setModal(modal); f.api.setModalOpen(true);
  f.menu.focus(); assert.equal(f.key('Tab').prevented, true); assert.equal(f.document.activeElement, button);
  button.disabled = true; f.api.focusDialog(modal);
  assert.equal(f.document.activeElement, modal);
  assert.equal(f.key('Tab').prevented, true); assert.equal(f.document.activeElement, modal);
});

test('resizing restores desktop navigation and moves focus away from a hidden mobile control', () => {
  const f = fixture(); f.api.toggleNavigation();
  f.media.matches = false; f.close.visible = false; f.mediaEvents.change();
  assert.equal(f.sidebar.inert, false); assert.equal(f.main.inert, false);
  assert.equal(f.document.activeElement, f.brand);
  f.media.matches = true; f.mediaEvents.change();
  assert.equal(f.sidebar.inert, true); assert.equal(f.document.activeElement, f.menu);
});

test('overlay scroll locks override stylesheet priorities and restore the original inline priority', () => {
  const f = fixture();
  f.document.body.style.setProperty('overflow', 'auto', 'important');
  f.api.toggleNavigation();
  assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.document.body.style.priority, 'important');
  f.api.closeNavigation();
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.document.body.style.priority, 'important');
});

test('route changes focus the new heading without stealing focus from an open dialog', () => {
  const f = fixture(); f.api.focusPage();
  assert.equal(f.heading.tabIndex, -1); assert.equal(f.document.activeElement, f.heading);
  const modal = f.element('section'); f.setModal(modal); modal.focus(); f.api.focusPage();
  assert.equal(f.document.activeElement, modal);
  modal.isConnected = false; f.api.focusDialog(modal); assert.equal(f.document.activeElement, modal);
});
