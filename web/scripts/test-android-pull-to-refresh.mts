/**
 * Android pull-to-refresh guard (#150): web/android/app/src/main/res/raw/ft_pull_to_refresh_guard.js
 * runs in a fake top-level window and reports, per touchstart, whether a pull may refresh.
 * Also checks the native wiring names match. Run: npx tsx --test scripts/test-android-pull-to-refresh.mts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const androidMain = new URL('../android/app/src/main/', import.meta.url);
const guardSource = readFileSync(new URL('res/raw/ft_pull_to_refresh_guard.js', androidMain), 'utf8');
const controllerSource = readFileSync(
  new URL('java/news/freedomtimes/app/WebViewPullToRefresh.java', androidMain),
  'utf8',
);
const activitySource = readFileSync(new URL('java/news/freedomtimes/app/MainActivity.java', androidMain), 'utf8');
const manifestSource = readFileSync(new URL('AndroidManifest.xml', androidMain), 'utf8');

type FakeElement = {
  nodeType: 1;
  tagName: string;
  type?: string;
  scrollTop: number;
  isContentEditable: boolean;
  touchAction: string;
  attrs: Set<string>;
  parentElement: FakeElement | null;
  hasAttribute(name: string): boolean;
};

function el(tagName: string, parent: FakeElement | null, extra: Partial<FakeElement> = {}): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    tagName,
    scrollTop: 0,
    isContentEditable: false,
    touchAction: 'auto',
    attrs: new Set(),
    parentElement: parent,
    hasAttribute(name: string) {
      return this.attrs.has(name);
    },
    ...extra,
  };
  return node;
}

function setup(options: { top?: 'self' | 'other'; bridge?: boolean; throwStyle?: boolean } = {}) {
  const reports: boolean[] = [];
  const listeners: Array<{ type: string; fn: (event: unknown) => void; opts: unknown }> = [];
  const html = el('HTML', null);
  const body = el('BODY', html);
  const doc = {
    documentElement: html,
    scrollingElement: html,
    body,
    fullscreenElement: null as unknown,
    activeElement: null as unknown,
    addEventListener(type: string, fn: (event: unknown) => void, opts: unknown) {
      listeners.push({ type, fn, opts });
    },
  };
  const win: Record<string, unknown> = {
    scrollY: 0,
    getComputedStyle(node: FakeElement) {
      if (options.throwStyle) throw new Error('boom');
      return { touchAction: node.touchAction };
    },
    getSelection() {
      return selection;
    },
  };
  const selection = { isCollapsed: true };
  win.top = options.top === 'other' ? {} : win;
  if (options.bridge !== false) {
    win.FTPullToRefresh = { reportGesture: (allowed: boolean) => reports.push(allowed) };
  }
  const run = () => vm.runInNewContext(guardSource, { window: win, document: doc });
  run();
  const touch = (target: FakeElement, touches = 1) => {
    const path: unknown[] = [];
    for (let node: FakeElement | null = target; node; node = node.parentElement) path.push(node);
    path.push(doc, win);
    for (const listener of listeners.filter((l) => l.type === 'touchstart')) {
      listener.fn({ target, touches: new Array(touches).fill({}), composedPath: () => path });
    }
    return reports.at(-1);
  };
  return { win, doc, html, body, reports, listeners, selection, touch, run };
}

test('installs one passive, capturing touchstart listener in the top frame only', () => {
  const page = setup();
  assert.equal(page.listeners.length, 1);
  assert.deepEqual({ ...(page.listeners[0].opts as object) }, { capture: true, passive: true });
  page.run();
  assert.equal(page.listeners.length, 1, 'idempotent: re-injection after load adds nothing');
  assert.equal(setup({ top: 'other' }).listeners.length, 0, 'never in an iframe');
  assert.equal(setup({ bridge: false }).listeners.length, 0, 'no native bridge: no listener');
});

test('a touch at the top of the page allows the pull', () => {
  const page = setup();
  const article = el('ARTICLE', page.body);
  assert.equal(page.touch(el('P', article)), true);
});

test('a scrolled page never allows the pull (no fighting mid-page scrolling)', () => {
  const page = setup();
  page.win.scrollY = 300;
  assert.equal(page.touch(el('P', page.body)), false);
  page.win.scrollY = 0;
  page.html.scrollTop = 12;
  assert.equal(page.touch(el('P', page.body)), false);
});

test('an inner scroller blocks only when it is not at its own top', () => {
  const page = setup();
  const scroller = el('DIV', page.body, { scrollTop: 80 });
  assert.equal(page.touch(el('LI', scroller)), false);
  scroller.scrollTop = 0;
  assert.equal(page.touch(el('LI', scroller)), true, 'admin layouts with an inner scroller at top still refresh');
});

test('embedded, editable and self-handled content keeps its own gestures', () => {
  for (const make of [
    (page: ReturnType<typeof setup>) => el('IFRAME', page.body),
    (page: ReturnType<typeof setup>) => el('VIDEO', page.body),
    (page: ReturnType<typeof setup>) => el('CANVAS', page.body),
    (page: ReturnType<typeof setup>) => el('TEXTAREA', page.body),
    (page: ReturnType<typeof setup>) => el('INPUT', page.body, { type: 'range' }),
    (page: ReturnType<typeof setup>) => el('SPAN', el('DIV', page.body, { isContentEditable: true }), { isContentEditable: true }),
    (page: ReturnType<typeof setup>) => el('SPAN', el('DIV', page.body, { touchAction: 'none' })),
    (page: ReturnType<typeof setup>) => el('SPAN', el('DIV', page.body, { touchAction: 'pan-x' })),
    (page: ReturnType<typeof setup>) => {
      const optOut = el('DIV', page.body);
      optOut.attrs.add('data-ft-no-pull-refresh');
      return el('SPAN', optOut);
    },
  ]) {
    const page = setup();
    assert.equal(page.touch(make(page)), false);
  }
  const page = setup();
  assert.equal(page.touch(el('SPAN', el('DIV', page.body, { touchAction: 'pan-y' }))), true);
  assert.equal(page.touch(el('INPUT', page.body, { type: 'text' })), true);
});

test('multi-touch, fullscreen, a text selection or a guard error block the pull', () => {
  const page = setup();
  assert.equal(page.touch(el('P', page.body), 2), false);
  page.doc.fullscreenElement = {};
  assert.equal(page.touch(el('P', page.body)), false);
  page.doc.fullscreenElement = null;
  page.selection.isCollapsed = false;
  assert.equal(page.touch(el('P', page.body)), false);
  assert.equal(setup({ throwStyle: true }).touch(el('P', el('DIV', null))), false);
});

test('no reload while an editor or form field has focus (unsaved work)', () => {
  const page = setup();
  const toolbar = el('DIV', page.body);
  for (const focused of [
    el('TEXTAREA', page.body),
    el('INPUT', page.body, { type: 'text' }),
    el('INPUT', page.body, { type: 'email' }),
    el('SELECT', page.body),
    el('DIV', page.body, { isContentEditable: true }),
    el('IFRAME', page.body),
  ]) {
    page.doc.activeElement = focused;
    assert.equal(page.touch(el('BUTTON', toolbar)), false, `focused ${focused.tagName} ${focused.type ?? ''}`);
  }
  for (const focused of [page.body, el('BUTTON', page.body), el('INPUT', page.body, { type: 'checkbox' }), null]) {
    page.doc.activeElement = focused;
    assert.equal(page.touch(el('BUTTON', toolbar)), true);
  }
});

test('native wiring matches the guard', () => {
  assert.match(guardSource, /win\.FTPullToRefresh/);
  assert.match(controllerSource, /JS_INTERFACE = "FTPullToRefresh"/);
  assert.match(controllerSource, /@JavascriptInterface\s+public void reportGesture\(boolean allowed\)/);
  assert.match(controllerSource, /R\.raw\.ft_pull_to_refresh_guard/);
  assert.match(controllerSource, /webView\.reload\(\)/, 'reloads the current URL on its own origin (#149)');
  assert.match(activitySource, /WebViewPullToRefresh\.install\(this, getBridge\(\)\)/);
  assert.match(manifestSource, /android\.permission\.ACCESS_NETWORK_STATE/);
});
