/*
 * Freedom Times Android pull-to-refresh guard (#150).
 *
 * Injected by WebViewPullToRefresh.java into the top frame (at document start where WebView
 * supports it, and again after each load). On every touchstart it tells the native
 * SwipeRefreshLayout whether a pull-down may refresh the page. It never cancels, delays or
 * changes the touch (passive listener). Pages can opt an element out with
 * data-ft-no-pull-refresh.
 */
(function (win, doc) {
  'use strict';
  try {
    if (!win || !doc || win.top !== win || win.__ftPullToRefreshGuard) {
      return;
    }
  } catch (e) {
    return;
  }
  var bridge = win.FTPullToRefresh;
  if (!bridge || typeof bridge.reportGesture !== 'function') {
    return;
  }
  win.__ftPullToRefreshGuard = true;

  // Content that owns its own vertical drags, or is embedded / editable.
  var BLOCK_TAGS = {
    IFRAME: true, FRAME: true, EMBED: true, OBJECT: true,
    VIDEO: true, AUDIO: true, CANVAS: true, TEXTAREA: true, SELECT: true,
  };

  function pageScrolled() {
    var root = doc.scrollingElement || doc.documentElement;
    return (win.scrollY || win.pageYOffset || 0) > 0
      || !!(root && root.scrollTop > 0)
      || !!(doc.body && doc.body.scrollTop > 0);
  }

  function allowsVerticalPan(touchAction) {
    var value = String(touchAction || 'auto').toLowerCase();
    return value === 'auto' || value === 'manipulation' || /pan-y|pan-down/.test(value);
  }

  function blockedBy(el) {
    var tag = String(el.tagName || '').toUpperCase();
    if (BLOCK_TAGS[tag]) return true;
    if (tag === 'INPUT' && String(el.type || '').toLowerCase() === 'range') return true;
    if (el.isContentEditable) return true;
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-ft-no-pull-refresh')) return true;
    // Only scroll containers report scrollTop > 0: an inner scroller not at its own top.
    if (el.scrollTop > 0) return true;
    var style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    if (style && !allowsVerticalPan(style.touchAction)) return true;
    return false;
  }

  function elementsUnder(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    var list = [];
    var i;
    if (path && path.length) {
      for (i = 0; i < path.length; i++) {
        if (path[i] && path[i].nodeType === 1) list.push(path[i]);
      }
      return list;
    }
    var el = event.target;
    if (el && el.nodeType !== 1) el = el.parentElement || null;
    for (; el && el.nodeType === 1; el = el.parentElement) list.push(el);
    return list;
  }

  var TEXT_INPUT_TYPES = {
    '': true, text: true, search: true, email: true, url: true, tel: true, password: true,
    number: true, date: true, 'datetime-local': true, month: true, time: true, week: true,
  };

  // Someone is typing (editor, form field): a reload would lose their unsaved work.
  function editingFocused() {
    var active = doc.activeElement;
    if (!active || active === doc.body || active === doc.documentElement) return false;
    if (active.isContentEditable) return true;
    var tag = String(active.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME') return true;
    if (tag === 'INPUT') return !!TEXT_INPUT_TYPES[String(active.type || '').toLowerCase()];
    return false;
  }

  function hasTextSelection() {
    var selection = typeof win.getSelection === 'function' ? win.getSelection() : null;
    return !!(selection && selection.isCollapsed === false);
  }

  function pullAllowed(event) {
    if (!event || !event.touches || event.touches.length !== 1) return false;
    if (pageScrolled() || doc.fullscreenElement || hasTextSelection() || editingFocused()) return false;
    var elements = elementsUnder(event);
    for (var i = 0; i < elements.length; i++) {
      if (blockedBy(elements[i])) return false;
    }
    return true;
  }

  doc.addEventListener('touchstart', function (event) {
    var allowed = false;
    try {
      allowed = pullAllowed(event);
    } catch (e) {
      allowed = false;
    }
    try {
      bridge.reportGesture(allowed);
    } catch (e) {
      // The native side treats "no report" as blocked.
    }
  }, { capture: true, passive: true });
})(window, document);
