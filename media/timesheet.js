// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));
  let state = /** @type {any} */ (null);
  let showHidden = false;

  const send = (msg) => vscode.postMessage(msg);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const fmt = (min) => {
    const m = Math.round(min);
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };

  const hours = (min) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

  /** "2:05", "2.5", "2h 5m", "1h", "45m", "45" (minutes) → minutes */
  const parseHours = (text) => {
    const t = text.trim().toLowerCase();
    let m;
    if ((m = /^(\d+):(\d{1,2})$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
    if ((m = /^(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/.exec(t))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60) + Number(m[2] || 0);
    if ((m = /^(\d+)\s*m$/.exec(t))) return Number(m[1]);
    if ((m = /^\d+[.,]\d+$/.exec(t))) return Math.round(parseFloat(t.replace(',', '.')) * 60);
    if ((m = /^\d+$/.exec(t))) return Number(t) <= 12 ? Number(t) * 60 : Number(t);
    return undefined;
  };

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'render') {
      state = msg;
      render();
    } else if (msg.type === 'toast') {
      showToast(msg.text);
    }
  });

  let toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function render() {
    // Keep focus, caret and any not-yet-sent text across re-renders.
    const focused = /** @type {HTMLInputElement | null} */ (document.activeElement?.closest('[data-field]') ?? null);
    const keep = focused && {
      key: focused.closest('[data-key]')?.getAttribute('data-key'),
      field: focused.dataset.field,
      value: focused.value,
      start: focused.selectionStart,
      end: focused.selectionEnd,
    };

    const { report, isToday, jira } = state;
    const visible = report.rows.filter((r) => !r.hidden);
    const hidden = report.rows.filter((r) => r.hidden);

    app.innerHTML = `
      <header class="top">
        <div class="nav">
          <button class="icon" data-act="prev" title="Previous day" aria-label="Previous day">‹</button>
          <div class="date">
            <h1>${esc(report.dateLabel)}</h1>
            ${isToday ? '<span class="pill">Today</span>' : '<button class="link" data-act="today">Back to today</button>'}
          </div>
          <button class="icon" data-act="next" title="Next day" aria-label="Next day">›</button>
        </div>
        <div class="summary">
          <div class="total">${fmt(report.totalMinutes)}</div>
          <div class="muted">${visible.length} ${visible.length === 1 ? 'task' : 'tasks'}</div>
        </div>
        <div class="actions">
          <button class="primary" data-act="copyAll" ${visible.length ? '' : 'disabled'}>Copy all</button>
          <button data-act="exportCsv" ${visible.length ? '' : 'disabled'}>Export CSV</button>
          <button data-act="addEntry">+ Add entry</button>
        </div>
      </header>
      <main>
        ${visible.length ? visible.map((r) => card(r, jira)).join('') : empty(isToday)}
        ${hidden.length ? hiddenSection(hidden) : ''}
      </main>`;

    if (keep?.key) {
      const el = /** @type {HTMLInputElement | null} */ (
        app.querySelector(`[data-key="${CSS.escape(keep.key)}"] [data-field="${keep.field}"]`)
      );
      if (el) {
        el.value = keep.value;
        el.focus();
        try {
          el.setSelectionRange(keep.start, keep.end);
        } catch {
          // Not all input types support selection.
        }
      }
    }
  }

  function card(r, jira) {
    const badge =
      r.kind === 'jira'
        ? `<span class="badge jira">${esc(r.key.replace(/#\d+$/, ''))}</span>`
        : `<span class="badge ${r.kind === 'manual' ? 'manual' : ''}">${r.kind === 'manual' ? 'Non-Jira' : r.kind === 'general' ? 'General' : 'Branch'}</span>`;
    const source = [
      ...r.commits.map((c) => `<li><span class="tag">commit</span>${esc(c)}</li>`),
      ...r.notes.map((n) => `<li><span class="tag">note</span>${esc(n)}</li>`),
    ];
    const diff = r.trackedMinutes !== r.minutes && !r.added;
    return `
      <article class="card${r.active ? ' active' : ''}" data-key="${esc(r.key)}">
        <div class="card-head">
          ${badge}
          <input class="title" data-field="title" value="${esc(r.title === r.key ? '' : r.title)}" placeholder="Title" aria-label="Title" spellcheck="false">
          ${r.active ? '<span class="live" title="Tracking now"><span class="dot"></span>Tracking</span>' : ''}
          ${r.summaryByAgent ? '<span class="agent" title="Description written by your coding agent">✦ agent summary</span>' : ''}
          ${r.edited && !r.added ? '<span class="edited" title="You edited this row">edited</span>' : ''}
        </div>
        <div class="times">
          <label><span>Start</span><input type="time" data-field="start" value="${esc(r.start)}"></label>
          <span class="arrow">→</span>
          <label><span>End</span><input type="time" data-field="end" value="${esc(r.end)}"></label>
          <label class="hours"><span>Hours</span><input data-field="minutes" value="${hours(r.minutes)}" title="e.g. 2:05, 2.5, 1h 30m"></label>
          ${diff ? `<span class="muted small" title="Active time measured by the tracker">tracked ${fmt(r.trackedMinutes)}</span>` : ''}
        </div>
        <div class="desc">
          <textarea data-field="description" rows="${Math.min(6, Math.max(2, Math.ceil(r.description.length / 90)))}" placeholder="What did you do?">${esc(r.description)}</textarea>
          <button class="icon copy" data-act="copyDesc" title="Copy description" aria-label="Copy description">⧉</button>
        </div>
        <footer>
          ${source.length ? `<details><summary>${sourceLabel(r)}</summary><ul>${source.join('')}</ul></details>` : '<span class="muted small">No commits or notes yet</span>'}
          <div class="row-actions">
            <button class="ghost" data-act="copyRow">Copy</button>
            ${r.kind === 'jira' && !r.key.startsWith('manual:') ? `<button class="ghost" data-act="openJira">${jira ? 'Open in Jira ↗' : 'Connect Jira'}</button>` : ''}
            ${r.added ? '<button class="ghost danger" data-act="reset">Remove</button>' : r.edited || r.summaryByAgent ? '<button class="ghost" data-act="reset" title="Go back to the tracked values and commit-based description">Reset</button>' : ''}
            ${r.added ? '' : '<button class="ghost" data-act="hide" title="Leave out of the timesheet">Hide</button>'}
          </div>
        </footer>
      </article>`;
  }

  function sourceLabel(r) {
    const parts = [];
    if (r.commits.length) parts.push(`${r.commits.length} commit${r.commits.length > 1 ? 's' : ''}`);
    if (r.notes.length) parts.push(`${r.notes.length} note${r.notes.length > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }

  function hiddenSection(rows) {
    return `
      <section class="hidden-rows">
        <button class="link" data-act="toggleHidden">${showHidden ? '▾' : '▸'} ${rows.length} hidden</button>
        ${
          showHidden
            ? rows
                .map(
                  (r) => `<div class="hidden-row" data-key="${esc(r.key)}">
                    <span>${esc(r.kind === 'jira' ? `${r.key} — ${r.title}` : r.title)}</span>
                    <span class="muted">${fmt(r.minutes)}</span>
                    <button class="ghost" data-act="unhide">Restore</button>
                  </div>`,
                )
                .join('')
            : ''
        }
      </section>`;
  }

  function empty(isToday) {
    return `<div class="empty">
      <div class="empty-icon">⏱</div>
      <p>${isToday ? 'Nothing tracked yet today.' : 'Nothing tracked on this day.'}</p>
      <p class="muted">${isToday ? 'Check out a task branch (e.g. <code>issue/TEST-101-…</code>) and start working, or start a non-Jira task from the status bar.' : 'Use “+ Add entry” to add time by hand.'}</p>
    </div>`;
  }

  // ---- events ---------------------------------------------------------------

  app.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
    if (!btn) return;
    const act = btn.dataset.act;
    const key = btn.closest('[data-key]')?.getAttribute('data-key') ?? undefined;
    switch (act) {
      case 'prev':
        return send({ type: 'nav', delta: -1 });
      case 'next':
        return send({ type: 'nav', delta: 1 });
      case 'today':
        return send({ type: 'nav', today: true });
      case 'toggleHidden':
        showHidden = !showHidden;
        return render();
      case 'copyDesc': {
        const ta = /** @type {HTMLTextAreaElement} */ (btn.parentElement?.querySelector('textarea'));
        return send({ type: 'copyText', text: ta.value });
      }
      case 'copyAll':
      case 'exportCsv':
      case 'addEntry':
        return send({ type: act });
      default:
        if (key) send({ type: act, key });
    }
  });

  const timers = new Map();
  function edit(el, immediate) {
    const key = el.closest('[data-key]')?.getAttribute('data-key');
    const field = el.dataset.field;
    if (!key || !field) return;
    let value = el.value;
    if (field === 'minutes') {
      value = parseHours(value);
      if (value === undefined) {
        el.classList.add('invalid');
        return;
      }
      el.classList.remove('invalid');
    }
    const id = `${key}|${field}`;
    clearTimeout(timers.get(id));
    if (immediate) {
      send({ type: 'edit', key, field, value });
    } else {
      timers.set(id, setTimeout(() => send({ type: 'edit', key, field, value }), 500));
    }
  }

  app.addEventListener('input', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (el.dataset.field === 'description' || el.dataset.field === 'title') edit(el, false);
  });

  app.addEventListener('change', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (el.dataset.field) edit(el, true);
  });

  app.addEventListener('keydown', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (e.key === 'Enter' && el.tagName === 'INPUT') el.blur();
  });

  send({ type: 'ready' });
})();
