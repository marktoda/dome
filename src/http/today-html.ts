// http/today-html: pure renderer — dome.daily.today/v1 structured data →
// a self-refreshing HTML cockpit page. No imports from the engine; consumed
// only by the HTTP adapter's GET /today route. Auto-refresh is a plain
// meta-refresh (the v1 plan's "dumb polling is acceptable" resolution); the
// page reloads its own URL, so a ?token= query parameter survives reloads.

export type TodayHtmlOptions = {
  readonly refreshSeconds: number;
};

export function renderTodayHtml(data: unknown, opts: TodayHtmlOptions): string {
  const refresh = Math.max(1, Math.floor(opts.refreshSeconds));
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? record.date : "today";
  const openTasks = rows(record.openTasks);
  const followups = rows(record.followups);
  const questions = questionRows(record.questions);
  const brief = parseBrief(record.brief);
  const calendar = parseCalendar(record.calendar);
  const hero = parseHero(record.hero);
  const total = openTasks.length + followups.length + questions.length;

  const allItems = [...openTasks, ...followups];
  const isAllClear = total === 0;

  const style = `
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: #0b0b0c;
      background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 24px 24px;
      color: #fff;
      font-family: -apple-system, system-ui, sans-serif;
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
    ? renderStillOpenHtml(allItems, date)
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
  questionRows: ReadonlyArray<QuestionRow>,
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
  function fingerprint(data) {
    return JSON.stringify(data);
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

type HeroItem =
  | { readonly kind: "task"; readonly item: TaskRow }
  | { readonly kind: "question"; readonly item: QuestionRow };

function renderHeroHtml(hero: HeroItem, today: string): string {
  if (hero.kind === "task") {
    const item = hero.item;
    let urgencyHtml = "";
    if (item.dueDate !== null) {
      if (item.dueDate < today) {
        urgencyHtml = `<span class="hero-urgency">overdue</span>`;
      } else if (item.dueDate === today) {
        urgencyHtml = `<span class="hero-urgency warn">due today</span>`;
      } else {
        urgencyHtml = `<span class="hero-urgency ok">due ${esc(item.dueDate)}</span>`;
      }
    }
    return `<div class="hero">
    <span class="hero-arrow">&#8594;</span>
    <span class="hero-text">${esc(item.text)}</span>
    ${urgencyHtml}
  </div>
  `;
  } else {
    const item = hero.item;
    return `<div class="hero">
    <span class="hero-arrow">&#8594;</span>
    <span class="hero-text">${esc(item.question)}</span>
  </div>
  `;
  }
}

function renderCalendarHtml(events: ReadonlyArray<CalendarEvent>): string {
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

function renderQuestionsHtml(questions: ReadonlyArray<QuestionRow>): string {
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

function renderStillOpenHtml(items: ReadonlyArray<TaskRow>, today: string): string {
  const itemsHtml = items.map((t) => {
    const glyph = taskGlyph(t, today);
    const where = t.line === null ? t.path : `${t.path}:${t.line}`;
    return `<div class="open-item reveal">
        <span class="open-glyph ${glyph.cls}">${glyph.char}</span>
        <div class="open-body">
          <div class="open-text">${esc(t.text)}</div>
          <div class="src">${esc(where)}</div>
        </div>
      </div>`;
  }).join("\n      ");

  return `<div class="still-open-header">
    <span class="section-label" style="margin-bottom:0">Still open</span>
    <span class="still-open-count">${items.length}</span>
  </div>
  <div class="still-open-grid">
      ${itemsHtml}
  </div>`;
}

function taskGlyph(
  t: TaskRow,
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

// ── Field types ─────────────────────────────────────────────────────────────

type TaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
};

type QuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly resolveCommand: string;
  readonly options: ReadonlyArray<string>;
};

type CalendarEvent = {
  readonly time: string;
  readonly title: string;
  readonly meta: string;
};

type BriefField = {
  readonly text: string;
  readonly sourceRef: { readonly path: string };
};

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseBrief(raw: unknown): BriefField | null {
  if (!isRecord(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text : null;
  if (text === null || text.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { text, sourceRef: { path } };
}

function parseCalendar(raw: unknown): { readonly events: ReadonlyArray<CalendarEvent>; readonly sourceRef: { readonly path: string } } | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.events)) return null;
  const events: CalendarEvent[] = raw.events.flatMap((ev) => {
    if (!isRecord(ev)) return [];
    const time = typeof ev.time === "string" ? ev.time : null;
    const title = typeof ev.title === "string" ? ev.title : null;
    if (time === null || title === null) return [];
    const meta = typeof ev.meta === "string" ? ev.meta : "";
    return [{ time, title, meta }];
  });
  if (events.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { events, sourceRef: { path } };
}

function parseHero(raw: unknown): HeroItem | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === "task") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.length === 0) return null;
    return {
      kind: "task",
      item: {
        text,
        path: typeof item.path === "string" ? item.path : "",
        line: typeof item.line === "number" ? item.line : null,
        dueDate: typeof item.dueDate === "string" ? item.dueDate : null,
      },
    };
  }
  if (kind === "question") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const question = typeof item.question === "string" ? item.question : "";
    if (question.length === 0) return null;
    const options: string[] = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === "string")
      : [];
    return {
      kind: "question",
      item: {
        id: typeof item.id === "number" ? item.id : 0,
        question,
        resolveCommand: typeof item.resolveCommand === "string"
          ? item.resolveCommand
          : "dome resolve <id> <value>",
        options,
      },
    };
  }
  return null;
}

// These parsers mirror src/cli/commands/today.ts's; extract to src/surface/ if a third full-shape consumer appears.
function rows(raw: unknown): ReadonlyArray<TaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const text = typeof r.text === "string" ? r.text : "";
    if (text.length === 0) return [];
    return [{
      text,
      path: typeof r.path === "string" ? r.path : "",
      line: typeof r.line === "number" ? r.line : null,
      dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
    }];
  });
}

function questionRows(raw: unknown): ReadonlyArray<QuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = isRecord(item) ? item : {};
    const question = typeof r.question === "string" ? r.question : "";
    if (question.length === 0) return [];
    const options: string[] = Array.isArray(r.options)
      ? r.options.filter((o): o is string => typeof o === "string")
      : [];
    return [{
      id: typeof r.id === "number" ? r.id : 0,
      question,
      resolveCommand: typeof r.resolveCommand === "string" ? r.resolveCommand : "dome resolve <id> <value>",
      options,
    }];
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
