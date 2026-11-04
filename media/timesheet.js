// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));
  let state = /** @type {any} */ (null);
  let showHidden = false;
  let showChecks = true;

  const send = (msg) => vscode.postMessage(msg);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const fmt = (min) => {
    const m = Math.round(min);
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };

  /** Odoo "Time Spent" format: 75 → "01:15" */
  const hhmm = (min) => {
    const m = Math.max(0, Math.round(min));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  /** "01:15", "1:15", "1.25", "1h 15m", "75m", "75" (minutes) → minutes */
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

    const { report, isToday, jira, projects } = state;
    const visible = report.rows.filter((r) => !r.hidden);
    const hidden = report.rows.filter((r) => r.hidden);
    const toLog = report.toLogMinutes;

    app.innerHTML = `
      <datalist id="projects">${projects.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
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
          <div class="total" title="Time Spent, all entries">${hhmm(report.totalMinutes)}</div>
          <div class="muted">${
            !visible.length ? 'no entries' : toLog ? `<span class="tolog">${hhmm(toLog)} to log</span>` : '<span class="ok">all logged ✓</span>'
          }</div>
        </div>
        <div class="actions">
          <button class="primary" data-act="copyAll" ${visible.length ? '' : 'disabled'}>Copy all</button>
          <button data-act="exportCsv" ${visible.length ? '' : 'disabled'}>Export CSV</button>
          <button data-act="addEntry">+ Add entry</button>
        </div>
      </header>
      ${visible.length ? checks(report) : ''}
      <main>
        ${visible.length ? visible.map((r) => card(r, jira, report.roundTo)).join('') : empty(isToday)}
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

  /** "Final verification" from the Odoo procedure. */
  function checks(report) {
    const failing = report.checks.filter((c) => !c.ok);
    const head = failing.length
      ? `<span class="warn-text">⚠ ${failing.length} ${failing.length === 1 ? 'check needs' : 'checks need'} attention</span>`
      : '<span class="ok">✓ Ready for Odoo</span>';
    return `
      <section class="checks ${failing.length ? 'has-issues' : 'all-ok'}">
        <button class="link checks-toggle" data-act="toggleChecks">${showChecks ? '▾' : '▸'} Final check · ${head}</button>
        ${
          showChecks
            ? `<ul>${report.checks
                .map(
                  (c) =>
                    `<li class="${c.ok ? 'ok' : 'warn-text'}">${c.ok ? '✓' : '⚠'} ${esc(c.label)}${c.detail ? ` <span class="muted">— ${esc(c.detail)}</span>` : ''}</li>`,
                )
                .join('')}</ul>`
            : ''
        }
      </section>`;
  }

  function card(r, jira, roundTo) {
    const isJira = r.kind === 'jira' && !r.displayKey.startsWith('manual:');
    const badge = isJira
      ? `<span class="badge jira">${esc(r.displayKey)}</span>`
      : `<span class="badge ${r.kind === 'manual' ? 'manual' : ''}">${r.kind === 'manual' ? 'Non-Jira' : r.kind === 'general' ? 'General' : 'Branch'}</span>`;
    const source = [
      ...r.commits.map((c) => `<li><span class="tag">commit</span>${esc(c)}</li>`),
      ...r.notes.map((n) => `<li><span class="tag">note</span>${esc(n)}</li>`),
    ];
    const status =
      r.loggedMinutes === 0
        ? `<span class="status tolog" title="Not entered in Odoo yet">Not logged</span>`
        : r.toLogMinutes === 0
          ? `<span class="status ok" title="Entered in Odoo">✓ Logged ${hhmm(r.loggedMinutes)}</span>`
          : `<span class="status tolog" title="Logged ${hhmm(r.loggedMinutes)} earlier; new time since then">Logged ${hhmm(r.loggedMinutes)} · ${hhmm(r.toLogMinutes)} to log</span>`;
    const timeNote = [
      r.start && r.end ? `${esc(r.start)}–${esc(r.end)}` : '',
      !r.added && r.trackedMinutes !== r.minutes ? `tracked ${fmt(r.trackedMinutes)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const descPlaceholder = isJira ? 'What did you do? e.g. Added the date filter and updated the query.' : 'What did you do? Be specific.';
    return `
      <article class="card${r.active ? ' active' : ''}${r.issues.length ? ' has-issues' : ''}" data-key="${esc(r.key)}">
        <div class="card-head">
          ${badge}
          <input class="title" data-field="title" value="${esc(r.title === r.key ? '' : r.title)}" placeholder="${isJira ? 'Title' : 'Category, e.g. Internal Administration'}" aria-label="Title" spellcheck="false">
          ${r.active ? '<span class="live" title="Tracking now"><span class="dot"></span>Tracking</span>' : ''}
          ${status}
        </div>

        <div class="fields">
          <label class="field project">
            <span>Project</span>
            <div class="with-copy">
              <input data-field="project" list="projects" value="${esc(r.project)}" placeholder="Choose or type the Odoo project" spellcheck="false">
              <button class="icon copy" data-act="copyField" data-copy="project" title="Copy project" aria-label="Copy project" ${r.project ? '' : 'disabled'}>⧉</button>
            </div>
            ${r.projectSuggested ? '<small class="muted">suggested from earlier entries</small>' : ''}
          </label>
          <label class="field time">
            <span>Time Spent</span>
            <div class="with-copy">
              <input data-field="minutes" value="${hhmm(r.minutes)}" title="HH:MM, e.g. 01:15 (rounded to ${roundTo || 1} min)">
              <button class="icon copy" data-act="copyField" data-copy="time" title="Copy time spent${r.loggedMinutes && r.toLogMinutes ? ' still to log' : ''}" aria-label="Copy time spent">⧉</button>
            </div>
            ${timeNote ? `<small class="muted">${timeNote}</small>` : ''}
          </label>
        </div>

        <label class="field">
          <span>Description
            ${r.summaryByAgent ? '<em class="agent" title="Written by your coding agent">✦ agent summary</em>' : ''}
            ${r.edited && !r.added ? '<em class="edited" title="You edited this entry">edited</em>' : ''}
          </span>
          <textarea data-field="description" rows="${Math.min(6, Math.max(2, Math.ceil(r.description.length / 90)))}" placeholder="${esc(descPlaceholder)}">${esc(r.description)}</textarea>
        </label>
        <div class="preview">
          <span class="muted">Odoo:</span>
          <span class="preview-text">${esc(r.odooDescription)}</span>
          <button class="icon copy" data-act="copyField" data-copy="description" title="Copy description for Odoo" aria-label="Copy description">⧉</button>
        </div>

        ${r.issues.length ? `<ul class="issues">${r.issues.map((i) => `<li>⚠ ${esc(i)}</li>`).join('')}</ul>` : ''}

        <footer>
          ${source.length ? `<details><summary>${sourceLabel(r)}</summary><ul>${source.join('')}</ul></details>` : '<span class="muted small">No commits or notes yet</span>'}
          <div class="row-actions">
            ${
              r.toLogMinutes > 0
                ? `<button class="primary small-btn" data-act="markLogged" title="I've entered this in Odoo">✓ Mark as logged</button>`
                : r.loggedMinutes > 0
                  ? '<button class="ghost" data-act="unlog" title="Mark as not logged">Undo logged</button>'
                  : ''
            }
            <button class="ghost" data-act="copyRow" title="Copy project, description and time">Copy</button>
            ${isJira ? `<button class="ghost" data-act="openJira">${jira ? 'Jira ↗' : 'Connect Jira'}</button>` : ''}
            ${r.added ? '<button class="ghost danger" data-act="reset">Remove</button>' : r.edited || r.summaryByAgent ? '<button class="ghost" data-act="reset" title="Go back to the tracked time and commit-based description">Reset</button>' : ''}
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
                    <span>${esc(r.kind === 'jira' ? `${r.displayKey} — ${r.title}` : r.title)}</span>
                    <span class="muted">${hhmm(r.minutes)}</span>
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
      <p class="muted">${isToday ? 'Click the status bar and choose <b>Create Task Branch</b> (e.g. <code>issue/TEST-101-…</code>), or start a non-Jira task.' : 'Use “+ Add entry” to add time by hand.'}</p>
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
      case 'toggleChecks':
        showChecks = !showChecks;
        return render();
      case 'copyField':
        e.preventDefault();
        if (key) send({ type: 'copyField', key, field: btn.dataset.copy });
        return;
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
