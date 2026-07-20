// ── Аналитика: клики, скролл, время на вкладке ──────────────────────────────
// Батчит события в памяти и шлёт их на /track раз в FLUSH_INTERVAL_MS,
// плюс принудительный flush при скрытии/закрытии страницы (sendBeacon).
(function () {
  'use strict';

  var SOURCE = 'app';
  var TRACK_ENDPOINT = '/track';

  var FLUSH_INTERVAL_MS = 10000;
  var MAX_QUEUE = 200;
  var SCROLL_MILESTONES = [25, 50, 75, 100];
  var SECTION_THRESHOLD = 0.5;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function getSessionId() {
    try {
      var id = sessionStorage.getItem('kaloriskan_session_id');
      if (!id) { id = uuid(); sessionStorage.setItem('kaloriskan_session_id', id); }
      return id;
    } catch (e) { return uuid(); }
  }

  function getDeviceId() {
    try { return localStorage.getItem('kaloriskan_device_id'); } catch (e) { return null; }
  }

  var sessionId = getSessionId();
  var deviceId = getDeviceId();
  var queue = [];

  function push(name, target, durationMs, meta) {
    if (queue.length >= MAX_QUEUE) return;
    var evt = { name: name, url: location.pathname };
    if (target) evt.target = target;
    if (durationMs !== undefined && durationMs !== null) evt.duration_ms = Math.round(durationMs);
    if (meta) evt.meta = meta;
    queue.push(evt);
  }

  function flush(useBeacon) {
    if (queue.length === 0) return;
    var events = queue;
    queue = [];
    var payload = JSON.stringify({ session_id: sessionId, device_id: deviceId, source: SOURCE, events: events });

    // sendBeacon как text/plain — чтобы кросс-доменный beacon (лендинг → app) не упирался
    // в CORS preflight, который Beacon API не умеет ждать.
    if (useBeacon && navigator.sendBeacon) {
      if (navigator.sendBeacon(TRACK_ENDPOINT, new Blob([payload], { type: 'text/plain' }))) return;
    }
    fetch(TRACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(function () {});
  }

  // ── Клики ─────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var el = e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!el) return;
    var label = el.id || el.dataset.track || (el.textContent || '').trim().slice(0, 60) || el.tagName.toLowerCase();
    push('click', label);
  }, true);

  // ── Глубина прокрутки ────────────────────────────────────────────────────
  var reachedMilestones = {};
  var scrollTicking = false;
  function checkScroll() {
    scrollTicking = false;
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - doc.clientHeight;
    if (scrollable <= 0) return;
    var pct = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
    SCROLL_MILESTONES.forEach(function (m) {
      if (pct >= m && !reachedMilestones[m]) {
        reachedMilestones[m] = true;
        push('scroll_depth', m + '%');
      }
    });
  }
  window.addEventListener('scroll', function () {
    if (!scrollTicking) { scrollTicking = true; requestAnimationFrame(checkScroll); }
  }, { passive: true });

  // ── Время на каждой части ([data-analytics-section]) ────────────────────
  // Для приложения это вкладки нижней навигации: анализ/дневник/вес/цели —
  // у них display:none, пока не активны, поэтому IntersectionObserver
  // естественным образом засекает именно время, когда вкладка реально видна.
  var sectionState = null;
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-analytics-section]'));
  if (sections.length && 'IntersectionObserver' in window) {
    sectionState = new Map();
    sections.forEach(function (el) {
      sectionState.set(el, { intersecting: false, timing: false, start: 0, total: 0, reported: 0 });
    });

    var startTiming = function (s) { s.timing = true; s.start = performance.now(); };
    var stopTiming = function (s) {
      if (!s.timing) return;
      s.total += performance.now() - s.start;
      s.timing = false;
    };

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var s = sectionState.get(entry.target);
        if (!s) return;
        s.intersecting = entry.isIntersecting;
        if (entry.isIntersecting && document.visibilityState === 'visible') startTiming(s);
        else stopTiming(s);
      });
    }, { threshold: SECTION_THRESHOLD });
    sections.forEach(function (el) { io.observe(el); });
  }

  function reportSectionTimes() {
    if (!sectionState) return;
    sectionState.forEach(function (s, el) {
      var current = s.total + (s.timing ? performance.now() - s.start : 0);
      var delta = current - s.reported;
      if (delta >= 500) {
        push('section_time', el.dataset.analyticsSection, delta);
        s.reported = current;
      }
    });
  }

  setInterval(function () { reportSectionTimes(); flush(false); }, FLUSH_INTERVAL_MS);

  function onHide() {
    if (sectionState) sectionState.forEach(function (s) { if (s.timing) { s.total += performance.now() - s.start; s.timing = false; } });
    reportSectionTimes();
    flush(true);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      onHide();
    } else if (sectionState) {
      sectionState.forEach(function (s) { if (s.intersecting) { s.timing = true; s.start = performance.now(); } });
    }
  });
  window.addEventListener('pagehide', onHide);

  push('page_view', null, null, document.referrer ? { referrer: document.referrer } : undefined);
})();
