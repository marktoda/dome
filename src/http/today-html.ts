// http/today-html: pure renderer — dome.daily.today/v1 structured data →
// the "Briefing" HTML cockpit page. No imports from the engine; consumed only
// by the HTTP adapter's GET /today route. The page server-renders the initial
// paint, then an inline (dependency-free) script polls GET /tasks every
// `refreshSeconds`, reloads on detected change, drives the live/reconnecting
// state, and posts answers (/resolve) + captures (/capture) with the bearer
// token read from the `?token=` query parameter (header-only on the POSTs).

export type TodayHtmlOptions = {
  readonly refreshSeconds: number;
};

import { addDays, daysBetween, parseTodayView, type TodayTaskRow, type TodayQuestionRow, type TodayCalendarEvent, type TodayHeroItem } from "../surface/today-view";

// @font-face: the design's Basel Grotesk (Book 485 / Medium 535). The woff2
// bytes are served from same-origin, year-cacheable routes (the HTTP adapter's
// GET /today/fonts/basel-{book,medium}.woff2, fed by ./today-fonts) and url()'d
// here — so the ~246KB of font bytes load once and cache, instead of being
// re-inlined as base64 on every no-store /today reload. Mono stays the system
// ui-monospace stack.
const FONT_FACE = `
    @font-face { font-family: "Basel Grotesk"; font-weight: 485; font-display: swap;
      src: url("/today/fonts/basel-book.woff2") format("woff2"); }
    @font-face { font-family: "Basel Grotesk"; font-weight: 535; font-display: swap;
      src: url("/today/fonts/basel-medium.woff2") format("woff2"); }`;

export function renderTodayHtml(data: unknown, opts: TodayHtmlOptions): string {
  const refresh = Math.max(1, Math.floor(opts.refreshSeconds));
  const view = parseTodayView(data);
  const { date, openTasks, followups, questions, brief, calendar, hero, counts } = view;
  // Use true totals from the shared parser counts (not the display-limited received lengths).
  const total = counts.openTasks + counts.followups + counts.questions;

  // The hero task is already the pill above — don't repeat it in "Still open".
  const heroKey =
    hero !== null && hero.kind === "task"
      ? `${hero.item.path}:${hero.item.line ?? ""}:${hero.item.text}`
      : null;
  const allItems = [...openTasks, ...followups].filter(
    (t) => heroKey === null || `${t.path}:${t.line ?? ""}:${t.text}` !== heroKey,
  );
  const isAllClear = total === 0;
  // True total for the "Still open" section (tasks + followups, hero shown separately).
  const heroIsTask = hero !== null && hero.kind === "task";
  const trueOpenCount = counts.openTasks + counts.followups - (heroIsTask ? 1 : 0);

  const style = `${FONT_FACE}
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: #0b0b0c;
      background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 24px 24px;
      color: #fff;
      font-family: "Basel Grotesk", -apple-system, system-ui, sans-serif;
      font-weight: 485;
      min-height: 100vh;
      padding: 40px 24px 100px;
    }
    .page { max-width: 900px; margin: 0 auto; }

    /* masthead */
    .masthead { display: flex; align-items: center; gap: 9px; margin-bottom: 20px; }
    .brand-dot { width: 10px; height: 10px; border-radius: 9999px; background: #FF37C7; box-shadow: 0 0 12px rgba(255,55,199,0.5); flex-shrink: 0; }
    .brand-name { font-size: 18px; font-weight: 535; letter-spacing: -0.01em; }

    /* header */
    .date-line { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 6px; }
    .greeting { font-size: 36px; letter-spacing: -0.02em; line-height: 1.05; margin: 0 0 24px; font-weight: 485; }

    /* brief */
    .brief-text { font-size: 19px; line-height: 1.57; color: rgba(255,255,255,0.92); margin: 0 0 8px; max-width: 64ch; letter-spacing: -0.005em; }
    .brief-prov { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: rgba(255,255,255,0.32); margin-bottom: 28px; }

    /* hero pill */
    .hero { display: inline-flex; gap: 12px; align-items: center; padding: 13px 18px; border: 1px solid rgba(255,55,199,0.35); border-radius: 15px; margin-bottom: 36px; }
    .hero-arrow { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #FF37C7; font-size: 16px; }
    .hero-text { font-size: 16px; color: #fff; }
    .hero-urgency { margin-left: 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #FF593C; }
    .hero-urgency.warn { color: #FFBF17; }
    .hero-urgency.ok { color: rgba(255,255,255,0.5); }

    /* two-column band */
    .band { display: grid; grid-template-columns: 1fr; gap: 36px; margin-bottom: 36px; }
    @media (min-width: 900px) {
      body { padding: 48px 44px 120px; }
      .band { grid-template-columns: 1fr 1fr; gap: 48px; }
      .still-open-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 48px; }
    }

    /* section labels */
    .section-label { font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 16px; }

    /* calendar */
    .cal-events { display: flex; flex-direction: column; }
    .cal-event { display: flex; gap: 16px; align-items: flex-start; padding-bottom: 18px; }
    .cal-event:last-child { padding-bottom: 0; }
    .cal-time { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; color: rgba(255,255,255,0.7); width: 50px; flex: 0 0 auto; }
    .cal-body { border-left: 1px solid rgba(255,255,255,0.12); padding-left: 16px; flex: 1; }
    .cal-title { font-size: 16px; }
    .cal-meta { font-size: 13px; color: rgba(255,255,255,0.45); margin-top: 3px; }

    /* questions */
    .question-card { background: #1A1A1A; border-radius: 15px; padding: 15px 18px; margin-bottom: 14px; }
    .question-card:last-child { margin-bottom: 0; }
    details > summary { list-style: none; cursor: pointer; display: flex; gap: 11px; align-items: flex-start; }
    details > summary::-webkit-details-marker { display: none; }
    .q-mark { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #3ADCFF; font-size: 15px; flex-shrink: 0; }
    .q-text { flex: 1; font-size: 15px; line-height: 1.42; }
    .q-caret { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: rgba(255,255,255,0.4); font-size: 14px; transition: transform .15s; flex-shrink: 0; }
    details[open] .q-caret { transform: rotate(90deg); }
    .q-cmd { margin-top: 13px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: rgba(255,255,255,0.8); background: #0d0d0d; border-radius: 11px; padding: 12px 14px; }

    /* still open */
    .still-open-header { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; border-top: 1px solid rgba(255,255,255,0.07); padding-top: 26px; }
    .still-open-count { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: rgba(255,255,255,0.35); }
    .still-open-grid { display: flex; flex-direction: column; gap: 13px; }
    .open-item { display: flex; gap: 11px; align-items: flex-start; }
    .open-glyph { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; flex-shrink: 0; }
    .open-glyph.overdue { color: #FF593C; }
    .open-glyph.warn { color: #FFBF17; }
    .open-glyph.open { color: rgba(255,255,255,0.5); }
    .open-body { flex: 1; }
    .open-text { font-size: 15px; line-height: 1.4; }
    .reveal .src { opacity: 0; transition: opacity .14s ease; }
    .reveal:hover .src { opacity: .55; }
    .src { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 3px; }
    .bucket-label { font-size: 0.7rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; opacity: 0.7; margin: 8px 0 4px; }
    .bucket-overdue { color: #FF593C; }
    .bucket-today { color: #FFBF17; }
    .bucket-week { color: #888; }
    .still-open-more { display: flex; gap: 10px; align-items: center; padding: 11px 12px; background: #1A1A1A; border-radius: 12px; margin-top: 8px; font-size: 13px; color: rgba(255,255,255,0.6); font-family: ui-monospace, "SF Mono", Menlo, monospace; }

    /* all-clear */
    .all-clear-wrap { display: flex; flex-direction: column; align-items: flex-start; padding: 40px 0; }
    .all-clear-heading { font-size: 36px; letter-spacing: -0.02em; line-height: 1.08; margin: 0 0 14px; font-weight: 485; }
    .all-clear-sub { font-size: 16px; line-height: 1.55; color: rgba(255,255,255,0.6); margin: 0 0 20px; max-width: 48ch; }
    .all-clear-check { display: flex; align-items: center; gap: 9px; }
    .check-mark { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #21C95E; font-size: 15px; }
    .check-label { font-size: 14px; color: rgba(255,255,255,0.7); }

    /* footer */
    .footer { display: flex; align-items: center; gap: 8px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: rgba(255,255,255,0.4); padding-top: 32px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 40px; }
    .live-dot { width: 6px; height: 6px; border-radius: 9999px; background: #21C95E; animation: domePulse 2.4s ease-in-out infinite; flex-shrink: 0; }
    @keyframes domePulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

    /* capture */
    .capture-wrap { margin-top: 20px; }
    #capture-toggle { background: none; border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.5); border-radius: 8px; padding: 7px 14px; font-family: ui-monospace,"SF Mono",Menlo,monospace; font-size: 12px; cursor: pointer; }
    #capture-toggle:hover { border-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.8); }
    #capture-box { display: none; flex-direction: column; gap: 8px; margin-top: 10px; }
    #capture-input { background: #1A1A1A; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #fff; font-size: 15px; font-family: -apple-system,system-ui,sans-serif; padding: 10px 14px; resize: vertical; min-height: 72px; width: 100%; max-width: 600px; }
    #capture-input:focus { outline: none; border-color: rgba(255,55,199,0.4); }
    .capture-row { display: flex; align-items: center; gap: 10px; }
    #capture-send { background: #FF37C7; border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 535; padding: 7px 16px; cursor: pointer; }
    #capture-send:disabled { opacity: .5; cursor: default; }
    #capture-status { font-family: ui-monospace,"SF Mono",Menlo,monospace; font-size: 12px; }

    /* question answer buttons */
    .q-options { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .q-opt-btn { background: #222; border: 1px solid rgba(255,255,255,0.15); border-radius: 7px; color: rgba(255,255,255,0.85); font-size: 13px; font-family: ui-monospace,"SF Mono",Menlo,monospace; padding: 5px 12px; cursor: pointer; }
    .q-opt-btn:hover { background: #2e2e2e; border-color: rgba(255,55,199,0.4); }
  `.trim();

  const mastheadHtml = `
  <div class="masthead">
    <span class="brand-dot"></span>
    <span class="brand-name">Dome</span>
  </div>`;

  const headerHtml = `
  <div class="date-line">${esc(date)}</div>
  <div class="greeting">Good morning.</div>`;

  const briefHtml = brief !== null
    ? `<p class="brief-text">${esc(brief.text)}</p>
  <div class="brief-prov">&#8627; ${esc(brief.sourceRef.path)} · brief</div>`
    : "";

  const heroHtml = hero !== null ? renderHeroHtml(hero, date) : "";

  const calendarHtml = calendar !== null && calendar.events.length > 0
    ? renderCalendarHtml(calendar.events)
    : "";

  const questionsHtml = questions.length > 0
    ? renderQuestionsHtml(questions)
    : "";

  const bandHtml = (calendarHtml.length > 0 || questionsHtml.length > 0)
    ? `<div class="band">${calendarHtml}${questionsHtml}</div>`
    : "";

  const stillOpenHtml = allItems.length > 0
    ? renderStillOpenHtml(allItems, date, trueOpenCount)
    : "";

  const allClearHtml = isAllClear
    ? `<div class="all-clear-wrap">
    <div class="all-clear-heading">You&#39;re clear.</div>
    <p class="all-clear-sub">Nothing open, no questions, inbox empty.</p>
    <div class="all-clear-check"><span class="check-mark">&#10003;</span><span class="check-label">vault healthy</span></div>
  </div>`
    : "";

  const footerHtml = `
  <div class="capture-wrap">
    <button id="capture-toggle">+ capture a thought</button>
    <div id="capture-box">
      <textarea id="capture-input" placeholder="What's on your mind?"></textarea>
      <div class="capture-row">
        <button id="capture-send">Send</button>
        <span id="capture-status"></span>
      </div>
    </div>
  </div>
  <div class="footer">
    <span class="live-dot"></span>
    updated just now</div>`;

  const bodyContent = isAllClear
    ? `${allClearHtml}`
    : `${briefHtml}
  ${heroHtml}${bandHtml}${stillOpenHtml}`;

  const scriptHtml = buildScriptHtml(refresh, questions);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dome today — ${esc(date)}</title>
<style>
${style}
</style>
</head>
<body>
<div class="page">
${mastheadHtml}
${headerHtml}
${bodyContent}
${footerHtml}
</div>
${scriptHtml}
</body>
</html>
`;
}

// ── Inline script ───────────────────────────────────────────────────────────

/**
 * Build the inline <script> block for JS polling, question answering, and
 * capture. Dependency-free; token is read from location.search at runtime.
 */
function buildScriptHtml(
  refreshSeconds: number,
  questionRows: ReadonlyArray<TodayQuestionRow>,
): string {
  // Embed the question IDs so the script knows which cards to wire up.
  // JSON.stringify is safe here — these are numbers, not user strings.
  const questionIdsJson = JSON.stringify(questionRows.map((q) => q.id));
  const pollMs = refreshSeconds * 1000;

  return `<script>
(function () {
  // ── Token ──────────────────────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  // Keep the token in this closure for the Authorization header on the
  // resolve/capture POSTs, but scrub it from the address bar / history so it
  // doesn't linger in the URL after the page reads it.
  if (token) {
    var u = new URL(location.href);
    u.searchParams.delete('token');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }

  // ── State ──────────────────────────────────────────────────────────────
  var lastFingerprint = '';
  var lastUpdatedAt = Date.now();
  var questionIds = ${questionIdsJson};
  var POLL_MS = ${pollMs};

  // ── Footer live indicator ──────────────────────────────────────────────
  var liveDot = document.querySelector('.live-dot');
  var footer = document.querySelector('.footer');

  function setLive(alive) {
    if (!liveDot) return;
    liveDot.style.background = alive ? '#21C95E' : '#888';
    liveDot.style.boxShadow = alive ? '' : 'none';
  }

  function updateFooterText(stale) {
    if (!footer) return;
    var secs = Math.round((Date.now() - lastUpdatedAt) / 1000);
    var ago = secs < 60 ? secs + 's ago' : Math.round(secs / 60) + 'm ago';
    var textNode = footer.lastChild;
    if (textNode && textNode.nodeType === 3) {
      textNode.textContent = stale
        ? ' reconnecting… last updated ' + ago
        : ' updated ' + ago;
    }
  }

  // ── Stale banner ──────────────────────────────────────────────────────
  var bannerEl = null;
  function showStaleBanner() {
    if (bannerEl) return;
    bannerEl = document.createElement('div');
    bannerEl.style.cssText = [
      'position:fixed','top:0','left:0','right:0',
      'background:rgba(30,30,30,.95)','color:rgba(255,255,255,.6)',
      'font-family:ui-monospace,"SF Mono",Menlo,monospace',
      'font-size:12px','text-align:center','padding:7px',
      'z-index:9999','letter-spacing:.02em',
    ].join(';');
    bannerEl.textContent = 'reconnecting…';
    document.body.prepend(bannerEl);
    document.querySelector('.page') && (document.querySelector('.page').style.opacity = '.55');
  }
  function hideStaleBanner() {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
    document.querySelector('.page') && (document.querySelector('.page').style.opacity = '');
  }

  // ── Polling ───────────────────────────────────────────────────────────
  // Project ONLY user-visible fields so the fingerprint is stable across ticks
  // when nothing on the page changed. Volatile bookkeeping (attention counters,
  // lastChangedAt, impressions/lastShown) is deliberately excluded — including
  // it would trigger spurious location.reload() flashes every poll.
  function fingerprint(data) {
    data = data || {};
    var hero = data.hero;
    var heroItem = hero && hero.item;
    var h = heroItem
      ? [hero.kind, heroItem.text, heroItem.question, heroItem.dueDate]
      : null;
    var cal = (data.calendar && data.calendar.events) || null;
    return JSON.stringify({
      b: data.brief && data.brief.text,
      h: h,
      o: (data.openTasks || []).map(function (t) { return [t.text, t.dueDate]; }),
      f: (data.followups || []).map(function (t) { return [t.text, t.dueDate]; }),
      q: (data.questions || []).map(function (x) { return [x.id, x.question]; }),
      c: data.counts,
      cal: cal,
    });
  }

  function poll() {
    fetch('/tasks', {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      hideStaleBanner();
      setLive(true);
      lastUpdatedAt = Date.now();
      var fp = fingerprint(data);
      if (lastFingerprint && fp !== lastFingerprint) {
        // Content changed — let the server re-render (one rendering path).
        location.reload();
        return;
      }
      lastFingerprint = fp;
    }).catch(function () {
      setLive(false);
      showStaleBanner();
    });
  }

  // Initial poll + interval.
  poll();
  setInterval(poll, POLL_MS);

  // Tick the "updated Ns ago" every 5 s.
  setInterval(function () { updateFooterText(!!bannerEl); }, 5000);

  // ── Answer questions ───────────────────────────────────────────────────
  function resolveQuestion(id, value, cardEl) {
    fetch('/resolve', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: id, value: value }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Optimistic removal: hide the card immediately.
      if (cardEl) {
        cardEl.style.transition = 'opacity .2s';
        cardEl.style.opacity = '0';
        setTimeout(function () {
          if (cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
          // Trigger a reload to re-render from the server;
          // small delay so the removal animation is visible first.
          location.reload();
        }, 350);
      }
    }).catch(function (err) {
      // Surface the error inline near the card.
      if (cardEl) {
        var errEl = document.createElement('div');
        errEl.style.cssText = 'font-size:12px;color:#FF593C;margin-top:6px;font-family:ui-monospace,"SF Mono",Menlo,monospace';
        errEl.textContent = 'resolve failed — try again';
        cardEl.appendChild(errEl);
        setTimeout(function () { if (errEl.parentNode) errEl.remove(); }, 3000);
      }
    });
  }

  // Wire answer buttons to question cards.
  // Cards are rendered with data-qid attributes by the server.
  questionIds.forEach(function (id) {
    var card = document.querySelector('[data-qid="' + id + '"]');
    if (!card) return;
    var btns = card.querySelectorAll('[data-qval]');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        resolveQuestion(id, btn.getAttribute('data-qval'), card);
      });
    });
  });

  // ── Capture ────────────────────────────────────────────────────────────
  var captureToggle = document.getElementById('capture-toggle');
  var captureBox = document.getElementById('capture-box');
  var captureInput = document.getElementById('capture-input');
  var captureSend = document.getElementById('capture-send');
  var captureStatus = document.getElementById('capture-status');

  if (captureToggle && captureBox) {
    captureToggle.addEventListener('click', function () {
      var hidden = captureBox.style.display === 'none' || captureBox.style.display === '';
      captureBox.style.display = hidden ? 'flex' : 'none';
      if (hidden && captureInput) captureInput.focus();
    });
  }

  if (captureSend && captureInput) {
    captureSend.addEventListener('click', function () { doCapture(); });
    captureInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doCapture();
    });
  }

  function doCapture() {
    var text = captureInput ? captureInput.value.trim() : '';
    if (!text) return;
    captureSend && (captureSend.disabled = true);
    fetch('/capture', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: text }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (captureInput) captureInput.value = '';
      if (captureStatus) {
        captureStatus.textContent = 'captured';
        captureStatus.style.color = '#21C95E';
        setTimeout(function () { if (captureStatus) captureStatus.textContent = ''; }, 2500);
      }
      if (captureBox) captureBox.style.display = 'none';
    }).catch(function () {
      if (captureStatus) {
        captureStatus.textContent = 'capture failed — try again';
        captureStatus.style.color = '#FF593C';
      }
    }).finally(function () {
      captureSend && (captureSend.disabled = false);
    });
  }
})();
</script>`;
}

// ── Section renderers ───────────────────────────────────────────────────────

function renderHeroHtml(hero: TodayHeroItem, today: string): string {
  if (hero.kind === "task") {
    const item = hero.item;
    let urgencyHtml = "";
    if (item.dueDate !== null) {
      if (item.dueDate < today) {
        urgencyHtml = `<span class="hero-urgency">overdue ${daysBetween(item.dueDate, today)}d</span>`;
      } else if (item.dueDate === today) {
        urgencyHtml = `<span class="hero-urgency warn">due today</span>`;
      } else {
        urgencyHtml = `<span class="hero-urgency ok">due ${esc(item.dueDate)}</span>`;
      }
    }
    return `<div class="hero">
    <span class="hero-arrow">&#8594;</span>
    <span class="hero-text">${esc(clampText(item.text, 100))}</span>
    ${urgencyHtml}
  </div>
  `;
  } else {
    const item = hero.item;
    return `<div class="hero">
    <span class="hero-arrow">&#8594;</span>
    <span class="hero-text">${esc(clampText(item.question, 100))}</span>
  </div>
  `;
  }
}

// Clamp the hero pill text so a long task doesn't balloon the pill; the full
// item is still in the list / --json.
function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function renderCalendarHtml(events: ReadonlyArray<TodayCalendarEvent>): string {
  const eventsHtml = events.map((ev) => `
      <div class="cal-event">
        <span class="cal-time">${esc(ev.time)}</span>
        <div class="cal-body">
          <div class="cal-title">${esc(ev.title)}</div>
          ${ev.meta.length > 0 ? `<div class="cal-meta">${esc(ev.meta)}</div>` : ""}
        </div>
      </div>`).join("");

  return `<div>
    <div class="section-label">On your calendar</div>
    <div class="cal-events">${eventsHtml}
    </div>
  </div>`;
}

function renderQuestionsHtml(questions: ReadonlyArray<TodayQuestionRow>): string {
  const itemsHtml = questions.map((q) => {
    const optionsHtml = q.options.length > 0
      ? `<div class="q-options">${q.options.map((opt) =>
          `<button class="q-opt-btn" data-qval="${esc(opt)}">${esc(opt)}</button>`,
        ).join("")}</div>`
      : "";
    return `
    <div class="question-card" data-qid="${q.id}">
      <details>
        <summary>
          <span class="q-mark">?</span>
          <span class="q-text">${esc(q.question)}</span>
          <span class="q-caret">&#8250;</span>
        </summary>
        <div class="q-cmd">${esc(q.resolveCommand)}</div>
        ${optionsHtml}
      </details>
    </div>`;
  }).join("");

  return `<div>
    <div class="section-label">Dome needs you</div>
    ${itemsHtml}
  </div>`;
}

function renderStillOpenHtml(
  items: ReadonlyArray<TodayTaskRow>,
  today: string,
  trueCount: number,
): string {
  // Compute the week boundary: +7 calendar days from today.
  const weekBound = addDays(today, 7);

  // Bucket items by urgency.
  const overdue = items.filter((t) => t.dueDate !== null && t.dueDate < today);
  const todayItems = items.filter((t) => t.dueDate === today);
  const thisWeek = items.filter(
    (t) => t.dueDate !== null && t.dueDate > today && t.dueDate <= weekBound,
  );

  function renderItem(t: TodayTaskRow): string {
    const glyph = taskGlyph(t, today);
    const where = t.line === null ? t.path : `${t.path}:${t.line}`;
    return `<div class="open-item reveal">
        <span class="open-glyph ${glyph.cls}">${glyph.char}</span>
        <div class="open-body">
          <div class="open-text">${esc(t.text)}</div>
          <div class="src">${esc(where)}</div>
        </div>
      </div>`;
  }

  function renderBucket(
    label: string,
    cls: string,
    bucketItems: ReadonlyArray<TodayTaskRow>,
  ): string {
    if (bucketItems.length === 0) return "";
    const rows = bucketItems.map(renderItem).join("\n      ");
    return `<div class="bucket-label ${cls}">${esc(label)} · ${bucketItems.length}</div>
      <div class="still-open-grid">
      ${rows}
      </div>`;
  }

  const overdueHtml = renderBucket("overdue", "bucket-overdue", overdue);
  const todayHtml = renderBucket("today", "bucket-today", todayItems);
  const thisWeekHtml = renderBucket("this week", "bucket-week", thisWeek);

  // Fall back to a flat list if all items are in the "later" bucket (no urgent items)
  // — this keeps the chip intact but still shows a flat list for the common case where
  // all displayed items are undated/far-future and only the chip is rendered.
  const hasUrgentContent = overdueHtml.length > 0 || todayHtml.length > 0 || thisWeekHtml.length > 0;
  const itemsHtml = hasUrgentContent
    ? `${overdueHtml}${todayHtml}${thisWeekHtml}`
    : items.map(renderItem).join("\n      ");

  const gridOrBuckets = hasUrgentContent
    ? itemsHtml
    : `<div class="still-open-grid">${itemsHtml}</div>`;

  // Derive the chip from what is actually rendered inline so the two branches can't
  // disagree with the header: (items shown inline) + chipCount === trueCount.
  // urgent branch shows only the overdue/today/this-week buckets; fallback shows all items.
  const shownInline = hasUrgentContent
    ? overdue.length + todayItems.length + thisWeek.length
    : items.length;
  const chipCount = Math.max(0, trueCount - shownInline);

  const chipHtml = chipCount > 0
    ? `<div class="still-open-more"><span>+</span><span>${chipCount} more, later</span></div>`
    : "";

  return `<div class="still-open-header">
    <span class="section-label" style="margin-bottom:0">Still open</span>
    <span class="still-open-count">${trueCount}</span>
  </div>
  ${gridOrBuckets}${chipHtml}`;
}

function taskGlyph(
  t: TodayTaskRow,
  today: string,
): { readonly char: string; readonly cls: string } {
  if (t.dueDate !== null && t.dueDate < today) {
    return { char: "&#10007;", cls: "overdue" };
  }
  if (t.dueDate !== null && t.dueDate === today) {
    return { char: "&#9888;", cls: "warn" };
  }
  return { char: "&#8226;", cls: "open" };
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
