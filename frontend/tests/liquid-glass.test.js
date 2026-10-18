'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../public/liquid-glass.js'), 'utf8');

function harness({ fine = true, reduce = false } = {}) {
  const listeners = new Map(), frames = new Map(), runs = [];
  let frameId = 0;
  const media = matches => ({ matches, listeners: new Set(), addEventListener(_type, fn) { this.listeners.add(fn); }, removeEventListener(_type, fn) { this.listeners.delete(fn); }, change(value) { this.matches = value; for (const fn of this.listeners) fn(); } });
  const pointer = media(fine), motion = media(reduce);
  class Node {
    constructor(attributes = {}, children = []) {
      this.values = new Map(Object.entries(attributes)); this.children = children; this.isConnected = true; this.scrollTop = 0;
      this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } };
      this.classes = new Set((attributes.class || '').split(' ').filter(Boolean));
      this.classList = { remove: name => this.classes.delete(name), add: name => this.classes.add(name) };
    }
    get attributes() { return [...this.values].map(([name, value]) => ({ name, value })); }
    setAttribute(key, value) { this.values.set(key, value); }
    removeAttribute(key) { this.values.delete(key); }
    getBoundingClientRect() { this.reads = (this.reads || 0) + 1; return { left: 10, top: 20, width: 200, height: 100 }; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
    cloneNode() { return new Node(Object.fromEntries(this.values), this.children.map(child => child.cloneNode())); }
    closest() { return this.values.has('data-glass-light') ? this : null; }
    remove() { this.isConnected = false; document.body.children = document.body.children.filter(child => child !== this); }
    animate(keyframes, options) {
      let finish, reject;
      const animation = { finished: new Promise((resolve, failure) => { finish = resolve; reject = failure; }), finish: () => finish(), cancel: () => { animation.cancelled = true; reject(new Error('Cancelled')); } };
      runs.push({ node: this, keyframes, options, animation }); return animation;
    }
  }
  const document = {
    hidden: false,
    body: { children: [], append(node) { this.children.push(node); } },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); },
  };
  const context = { document, matchMedia: query => query.includes('reduced') ? motion : pointer,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: () => ({ background: 'white', border: '1px solid gray', borderRadius: '20px', boxShadow: 'none', color: 'black', font: '13px sans-serif' }),
  };
  context.window = context; vm.createContext(context); vm.runInContext(source, context);
  return { api: context.AmishnaGlass, document, Node, pointer, motion, frames, runs, listeners,
    flush() { const current = [...frames.values()]; frames.clear(); for (const fn of current) fn(); },
    move(target, x, y, pointerType = 'mouse') { document.dispatch('pointermove', { target, clientX: x, clientY: y, pointerType }); },
  };
}

test('pointer lighting opts in individual surfaces and coalesces rapid movement into one paint', () => {
  const h = harness(), panel = new h.Node({ 'data-glass-light': '' }), table = new h.Node();
  h.move(table, 20, 30); assert.equal(h.frames.size, 0);
  for (let x = 0; x < 100; x++) h.move(panel, x, 60);
  assert.equal(h.frames.size, 1); assert.equal(panel.reads, undefined);
  h.flush(); assert.equal(panel.reads, 1);
  assert.equal(panel.style['--glass-pointer-x'], '89.0px');
  assert.equal(panel.style['--glass-pointer-y'], '40.0px');
  assert.equal(panel.values.get('data-glass-active'), 'true');
  h.move(table, 20, 30); h.flush();
  assert.equal(panel.values.has('data-glass-active'), false);
});

test('touch input and reduced motion never retain pointer lighting', () => {
  const touch = harness({ fine: false });
  assert.equal(touch.listeners.get('pointermove')?.size || 0, 0);
  const h = harness(), panel = new h.Node({ 'data-glass-light': '' });
  h.move(panel, 30, 50); h.flush(); h.move(panel, 30, 50, 'touch');
  assert.equal(panel.values.has('data-glass-active'), false);
  h.move(panel, 30, 50); h.motion.change(true); h.flush();
  assert.equal(panel.values.has('data-glass-active'), false);
  assert.equal(h.listeners.get('pointermove').size, 0);
  h.motion.change(false); assert.equal(h.listeners.get('pointermove').size, 1);
  h.motion.change(false); assert.equal(h.listeners.get('pointermove').size, 1);
});

test('destroy removes pending effects and all listeners without allowing them to restart', () => {
  const h = harness(), panel = new h.Node({ 'data-glass-light': '' });
  h.move(panel, 30, 50); h.api.destroy(); h.flush();
  assert.equal(panel.reads, undefined); assert.equal(h.listeners.get('pointermove').size, 0);
  h.api.destroy(); h.pointer.change(false); h.pointer.change(true); h.document.dispatch('visibilitychange');
  assert.equal(h.listeners.get('pointermove').size, 0);
  assert.equal(h.pointer.listeners.size, 0); assert.equal(h.motion.listeners.size, 0);
});

test('modal snapshot cannot be mistaken for a live dialog and disappears on destroy', async () => {
  const h = harness(), button = new h.Node({ id: 'save', name: 'action', 'data-action': 'save', autofocus: '' });
  const modal = new h.Node({ id: 'dialog', class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [button]);
  h.api.exitModal(modal);
  assert.equal(h.document.body.children.length, 1);
  const ghost = h.document.body.children[0];
  assert.equal(ghost.inert, true); assert.equal(ghost.values.get('aria-hidden'), 'true');
  assert.equal(ghost.classes.has('modal'), false); assert.equal(ghost.values.has('id'), false);
  assert.equal(ghost.children[0].values.has('data-action'), false);
  assert.equal(ghost.children[0].values.has('name'), false);
  assert.equal(modal.values.get('id'), 'dialog'); assert.equal(button.values.get('data-action'), 'save');
  h.api.destroy();
  assert.equal(h.document.body.children.length, 0); assert.equal(h.runs[0].animation.cancelled, true);
  await Promise.resolve();
});

test('reduced motion skips both modal animations and any exit snapshot', () => {
  const h = harness({ reduce: true }), modal = new h.Node({ class: 'modal' });
  h.api.enterModal(modal); h.api.exitModal(modal);
  assert.equal(h.runs.length, 0); assert.equal(h.document.body.children.length, 0);
});
