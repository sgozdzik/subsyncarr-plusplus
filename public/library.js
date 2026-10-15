// Library page: folder tree of all subtitle files, manual runs, per-file details and debug info.
(function () {
  const { api, escapeHtml, formatDateTime, formatBytes, formatDuration, toast, copyText, connectLive, ENGINE_SHORT } =
    window.UI;

  const ICONS = { done: '✓', failed: '✗', 'auto-skipped': '⊘', 'not-run': '·', 'n/a': '–' };
  const STATUS_TEXT = {
    done: 'synced',
    failed: 'failed',
    'auto-skipped': 'auto-skipped (runs only when picked manually)',
    'not-run': 'not run yet',
    'n/a': 'not applicable',
  };

  const state = {
    snapshot: null,
    roots: [],
    expanded: new Set(load('library.expanded', [])),
    selected: new Set(),
    running: new Map(),
    engines: load('library.engines', null),
    search: '',
    filter: 'all',
    details: null,
  };

  function load(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode); not critical
    }
  }

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- data

  async function fetchLibrary(refresh) {
    $('libraryInfo').textContent = refresh ? 'Scanning folders…' : 'Loading…';
    $('rescan').disabled = true;
    try {
      state.snapshot = await api(`/api/library${refresh ? '?refresh=1' : ''}`);
      if (!state.engines) {
        state.engines = state.snapshot.enabledEngines;
      }
      buildTree();
      render();
    } catch (error) {
      $('libraryInfo').textContent = `Could not load the library: ${error.message}`;
      toast(error.message, 'error');
    } finally {
      $('rescan').disabled = false;
    }
  }

  function buildTree() {
    const roots = state.snapshot.roots.map((root) => ({
      path: root,
      name: root,
      folders: new Map(),
      files: [],
      root: true,
    }));
    for (const file of state.snapshot.files) {
      const root = roots.find((r) => r.path === file.root);
      if (!root) {
        continue;
      }
      let node = root;
      let path = root.path.replace(/\/$/, '');
      for (const part of file.dir.slice(path.length).split('/').filter(Boolean)) {
        path = `${path}/${part}`;
        if (!node.folders.has(part)) {
          node.folders.set(part, { path, name: part, folders: new Map(), files: [] });
        }
        node = node.folders.get(part);
      }
      node.files.push(file);
    }
    state.roots = roots;
  }

  function matches(file) {
    if (state.search && !file.path.toLowerCase().includes(state.search)) {
      return false;
    }
    const engines = Object.values(file.engines);
    const cs = file.engines.claudesynchro;
    switch (state.filter) {
      case 'needs':
        return ['not-run', 'failed', 'auto-skipped'].includes(cs.status);
      case 'done':
        return cs.status === 'done';
      case 'failed':
        return engines.some((e) => e.status === 'failed' || e.status === 'auto-skipped');
      case 'skipped':
        return engines.some((e) => e.status === 'auto-skipped');
      case 'novideo':
        return !file.video;
      default:
        return true;
    }
  }

  /** Matching files in a folder and its subfolders. */
  function filesUnder(node, out = []) {
    for (const file of node.files) {
      if (matches(file)) {
        out.push(file);
      }
    }
    for (const child of node.folders.values()) {
      filesUnder(child, out);
    }
    return out;
  }

  function findFolder(path, nodes = state.roots) {
    for (const node of nodes) {
      if (node.path === path) {
        return node;
      }
      const found = findFolder(path, [...node.folders.values()]);
      if (found) {
        return found;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- rendering

  function pill(engine, st) {
    const failures = st.status === 'failed' && st.failures > 1 ? st.failures : '';
    const title = [
      `${engine}: ${STATUS_TEXT[st.status]}`,
      st.note,
      st.failures ? `${st.failures} failure(s) in a row` : null,
      st.lastRunTime ? `last run ${formatDateTime(st.lastRunTime)}` : null,
      st.lastMessage,
    ]
      .filter(Boolean)
      .join('\n');
    return `<span class="pill pill-${st.status.replace('/', '-')}" title="${escapeHtml(title)}">${ENGINE_SHORT[engine]}${ICONS[st.status]}${failures}</span>`;
  }

  function summary(files) {
    const counts = { done: 0, failed: 0, 'auto-skipped': 0 };
    for (const f of files) {
      const status = f.engines.claudesynchro.status;
      if (status in counts) {
        counts[status]++;
      }
    }
    const parts = [];
    if (counts.done) parts.push(`<span class="ok">✓${counts.done}</span>`);
    if (counts.failed) parts.push(`<span class="bad">✗${counts.failed}</span>`);
    if (counts['auto-skipped']) parts.push(`<span class="warn">⊘${counts['auto-skipped']}</span>`);
    return parts.length ? `Cs ${parts.join(' ')}` : '';
  }

  function renderFile(file, depth) {
    const running = state.running.get(file.path);
    const lang = file.language ? `<span class="badge">${escapeHtml(file.language.toUpperCase())}</span>` : '';
    const video = file.video
      ? ''
      : '<span class="badge badge-warn" title="No video with a matching name">no video</span>';
    return `
      <div class="tree-row file${running ? ' running' : ''}" style="--depth:${depth}" data-file="${escapeHtml(file.path)}">
        <span class="caret-spacer"></span>
        <input type="checkbox" class="sel-file" ${state.selected.has(file.path) ? 'checked' : ''} />
        <span class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
        ${lang}${video}
        <span class="running-label">${running ? `⚙ ${escapeHtml(running)}` : ''}</span>
        <span class="pills">${state.snapshot.engines.map((e) => pill(e, file.engines[e])).join('')}</span>
        <span class="row-actions">
          <button class="icon-btn" data-action="run-file" title="Run now">▶</button>
          <button class="icon-btn" data-action="details" title="Details and debug info">ⓘ</button>
        </span>
      </div>`;
  }

  function renderFolder(node, depth, filtering) {
    const files = filesUnder(node);
    if (files.length === 0 && (filtering || !node.root)) {
      return '';
    }
    const open = filtering || state.expanded.has(node.path) || (node.root && !state.expanded.has(`!${node.path}`));
    const selectedCount = files.filter((f) => state.selected.has(f.path)).length;
    const checked = files.length > 0 && selectedCount === files.length;
    const partial = selectedCount > 0 && !checked;
    let html = `
      <div class="tree-row folder${node.root ? ' root' : ''}" style="--depth:${depth}" data-folder="${escapeHtml(node.path)}">
        <button class="caret" data-action="toggle">${open ? '▾' : '▸'}</button>
        <input type="checkbox" class="sel-folder" ${checked ? 'checked' : ''} ${partial ? 'data-partial="1"' : ''} />
        <span class="folder-name" data-action="toggle">📁 ${escapeHtml(node.name)}</span>
        <span class="folder-count">${files.length} file${files.length === 1 ? '' : 's'}</span>
        <span class="folder-summary">${summary(files)}</span>
        <span class="row-actions">
          <button class="icon-btn" data-action="run-folder" title="Run every file in this folder">▶</button>
        </span>
      </div>`;
    if (open) {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
      html += folders.map((child) => renderFolder(child, depth + 1, filtering)).join('');
      html += node.files
        .filter(matches)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => renderFile(file, depth + 1))
        .join('');
    }
    return html;
  }

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) {
      return;
    }
    const filtering = Boolean(state.search) || state.filter !== 'all';
    const folders = new Set(snapshot.files.map((f) => f.dir)).size;
    const shown = state.roots.reduce((n, root) => n + filesUnder(root).length, 0);
    let info = `${snapshot.files.length} subtitle file(s) in ${folders} folder(s)`;
    if (filtering) {
      info += ` · ${shown} shown`;
    }
    info += ` · scanned ${formatDateTime(snapshot.scannedAt)} (${formatDuration(snapshot.durationMs)})`;
    if (snapshot.errors.length) {
      info += ` · ⚠ ${snapshot.errors.length} folder(s) could not be read: ${snapshot.errors.slice(0, 3).join('; ')}`;
    }
    $('libraryInfo').textContent = info;

    const html = state.roots.map((root) => renderFolder(root, 0, filtering)).join('');
    $('tree').innerHTML =
      html || `<p class="no-data">${filtering ? 'No files match.' : 'No subtitle files found in the scan paths.'}</p>`;
    $('tree')
      .querySelectorAll('[data-partial]')
      .forEach((el) => (el.indeterminate = true));
    renderSelectionBar();
  }

  /** Files with a video but no claudesynchro result yet (never run, or failed fewer times than the limit). */
  function missingClaudesynchro() {
    if (!state.snapshot) {
      return [];
    }
    return state.snapshot.files.filter(
      (f) => f.video && ['not-run', 'failed'].includes(f.engines.claudesynchro.status),
    );
  }

  function renderSelectionBar() {
    const missing = missingClaudesynchro().length;
    $('syncMissing').textContent = `✨ Sync missing with claudesynchro (${missing})`;
    $('syncMissing').disabled = missing === 0;
    const count = state.selected.size;
    $('selectionBar').classList.toggle('hidden', count === 0);
    document.body.classList.toggle('has-selection', count > 0);
    $('selectionCount').textContent = `${count} file${count === 1 ? '' : 's'} selected`;
    if (!$('engineChoices').dataset.ready && state.snapshot) {
      $('engineChoices').innerHTML = state.snapshot.engines
        .map(
          (e) =>
            `<label class="checkbox"><input type="checkbox" value="${e}" ${state.engines.includes(e) ? 'checked' : ''} /> ${e}</label>`,
        )
        .join('');
      $('engineChoices').dataset.ready = '1';
    }
  }

  function setRunning(path, engine) {
    if (engine) {
      state.running.set(path, engine);
    } else {
      state.running.delete(path);
    }
    const row = $('tree').querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (row) {
      row.classList.toggle('running', Boolean(engine));
      row.querySelector('.running-label').textContent = engine ? `⚙ ${engine}` : '';
    }
  }

  function showBanner(text) {
    $('runBanner').classList.toggle('hidden', !text);
    $('runBanner').innerHTML = text || '';
  }

  // ---------------------------------------------------------------- actions

  async function runFiles(files, label, engines = state.engines, force = $('forceRun').checked) {
    if (files.length === 0) {
      return;
    }
    if (engines.length === 0) {
      toast('Pick at least one engine in the selection bar', 'error');
      return;
    }
    try {
      const result = await api('/api/run/files', { method: 'POST', body: { files, engines, force } });
      toast(
        result.queued
          ? `${label}: queued behind the current run (position ${result.position})`
          : `${label}: started (${engines.join(', ')})`,
        'success',
      );
    } catch (error) {
      toast(`Could not start: ${error.message}`, 'error');
    }
  }

  function toggleFolder(path) {
    const node = findFolder(path);
    const isOpen = state.expanded.has(path) || (node && node.root && !state.expanded.has(`!${path}`));
    if (node && node.root) {
      if (isOpen) {
        state.expanded.add(`!${path}`);
      } else {
        state.expanded.delete(`!${path}`);
      }
    } else if (isOpen) {
      state.expanded.delete(path);
    } else {
      state.expanded.add(path);
    }
    save('library.expanded', [...state.expanded]);
    render();
  }

  function onTreeClick(event) {
    const row = event.target.closest('.tree-row');
    if (!row) {
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    const folderPath = row.dataset.folder;
    const filePath = row.dataset.file;

    if (event.target.classList.contains('sel-folder')) {
      const files = filesUnder(findFolder(folderPath));
      const select = event.target.checked;
      files.forEach((f) => (select ? state.selected.add(f.path) : state.selected.delete(f.path)));
      render();
      return;
    }
    if (event.target.classList.contains('sel-file')) {
      if (event.target.checked) {
        state.selected.add(filePath);
      } else {
        state.selected.delete(filePath);
      }
      render();
      return;
    }
    if (action === 'toggle' && folderPath) {
      toggleFolder(folderPath);
    } else if (action === 'run-folder') {
      const files = filesUnder(findFolder(folderPath)).map((f) => f.path);
      if (files.length > 20 && !confirm(`Run ${files.length} files from this folder?`)) {
        return;
      }
      runFiles(files, `${files.length} file(s)`);
    } else if (action === 'run-file') {
      runFiles([filePath], filePath.split('/').pop());
    } else if (action === 'details') {
      openDetails(filePath);
    }
  }

  // ---------------------------------------------------------------- details

  async function openDetails(path) {
    $('detailsTitle').textContent = path.split('/').pop();
    $('detailsBody').innerHTML = '<p class="no-data">Loading…</p>';
    $('detailsModal').classList.remove('hidden');
    try {
      state.details = await api(`/api/library/file?path=${encodeURIComponent(path)}`);
      state.details.path = path;
      renderDetails();
    } catch (error) {
      $('detailsBody').innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
    }
  }

  function renderReport(report) {
    if (!report) {
      return '<p class="muted">No claudesynchro report yet.</p>';
    }
    const cuts = (report.cuts || [])
      .map(
        (c) =>
          `<li>${escapeHtml(c.video_time)} in the video: ${escapeHtml(c.kind)} (${c.jump > 0 ? '+' : ''}${c.jump}s${c.dropped ? `, ${c.dropped} line(s) dropped` : ''})</li>`,
      )
      .join('');
    const dropped = (report.dropped_lines || [])
      .slice(0, 10)
      .map((d) => `<li><code>${escapeHtml(d.time)}</code> ${escapeHtml(d.text)}</li>`)
      .join('');
    return `
      <p><strong>${report.status === 'synced' ? 'Synced' : 'Not written'}</strong> · confidence
        ${Math.round((report.confidence || 0) * 100)}% · reference: ${escapeHtml(report.reference?.label || '?')}
        · speed ×${Number(report.speed || 1).toFixed(4)} · ${report.filled?.lines || 0} line(s) filled
        · ${report.seconds ?? '?'}s</p>
      ${cuts ? `<p>Cuts:</p><ul>${cuts}</ul>` : '<p>No cuts found.</p>'}
      ${dropped ? `<details><summary>Dropped lines (${report.dropped_lines.length})</summary><ul>${dropped}</ul></details>` : ''}
      <p><a href="/api/claudesynchro/report?file=${encodeURIComponent(state.details.path)}" target="_blank">Full report (JSON)</a></p>`;
  }

  function renderDetails() {
    const d = state.details;
    const file = d.file;
    const states = Object.fromEntries(d.engineStates.map((s) => [s.engine, s]));
    const engineRows = (state.snapshot?.engines || Object.keys(ENGINE_SHORT))
      .map((engine) => {
        const st = file?.engines[engine];
        const row = states[engine];
        const detailsBlock = row?.last_details
          ? `<details><summary>output</summary><pre class="error-output">${escapeHtml(row.last_details)}</pre></details>`
          : '';
        return `<tr>
          <td>${engine}</td>
          <td>${st ? pill(engine, st) : ''} ${st ? STATUS_TEXT[st.status] : ''}${st?.note ? ` (${escapeHtml(st.note)})` : ''}</td>
          <td>${row?.consecutive_failures ?? 0}</td>
          <td>${row?.last_run_time ? formatDateTime(row.last_run_time) : '-'}</td>
          <td>${row?.last_duration_ms != null ? formatDuration(row.last_duration_ms) : '-'}</td>
          <td class="message-cell">${escapeHtml(row?.last_message || '')}${detailsBlock}</td>
        </tr>`;
      })
      .join('');
    const history = d.history
      .map((h) => {
        const engines = Object.entries(h.engines)
          .map(([e, r]) => `${ENGINE_SHORT[e] || e}${r.cancelled ? '⊘' : r.skipped ? '–' : r.success ? '✓' : '✗'}`)
          .join(' ');
        return `<tr><td>${formatDateTime(h.run_start_time)}</td><td>${escapeHtml(h.run_source || '')}</td><td>${escapeHtml(h.status)}</td><td>${escapeHtml(engines)}</td></tr>`;
      })
      .join('');
    $('detailsBody').innerHTML = `
      <dl class="facts">
        <dt>Subtitle</dt><dd>${escapeHtml(d.path)}</dd>
        <dt>Video</dt><dd>${file?.video ? escapeHtml(file.video) : '<span class="error-text">no matching video found</span>'}</dd>
        <dt>Language</dt><dd>${escapeHtml(file?.language || 'not tagged (detected from the text)')}</dd>
        <dt>Size / modified</dt><dd>${file ? `${formatBytes(file.size)} · ${formatDateTime(file.mtime)}` : '-'}</dd>
      </dl>
      <h4>Engines</h4>
      <p class="muted">An engine that fails ${d.maxFailures} times in a row is skipped by scheduled runs; ▶ Run now always runs it.</p>
      <table class="details-table">
        <thead><tr><th>Engine</th><th>Status</th><th>Failures</th><th>Last run</th><th>Took</th><th>Last message</th></tr></thead>
        <tbody>${engineRows}</tbody>
      </table>
      <h4>claudesynchro report</h4>
      ${renderReport(d.claudesynchroReport)}
      <h4>Recent runs of this file</h4>
      ${history ? `<table class="details-table"><thead><tr><th>Run</th><th>Started by</th><th>Result</th><th>Engines</th></tr></thead><tbody>${history}</tbody></table>` : '<p class="muted">Not processed yet.</p>'}`;
  }

  function detailsAsText() {
    const d = state.details;
    const lines = ['## Subsyncarr++ file debug info', `Subtitle: ${d.path}`];
    lines.push(`Video: ${d.file?.video || 'none'}`, `Language: ${d.file?.language || 'untagged'}`, '');
    for (const row of d.engineStates) {
      lines.push(
        `### ${row.engine}: ${row.last_status || 'never run'}, ${row.consecutive_failures} failure(s) in a row, last ${row.last_run_time ? new Date(row.last_run_time).toISOString() : '-'}`,
      );
      if (row.last_message) lines.push(row.last_message);
      if (row.last_details) lines.push('```', row.last_details, '```');
    }
    if (d.claudesynchroReport) {
      const { dropped_lines: droppedLines, ...report } = d.claudesynchroReport;
      lines.push('', '### claudesynchro report', '```json', JSON.stringify(report, null, 1), '```');
      if (droppedLines?.length) {
        lines.push(`Dropped lines: ${droppedLines.length} (first: ${droppedLines[0].time} ${droppedLines[0].text})`);
      }
    }
    lines.push('', '### Recent runs');
    for (const h of d.history.slice(0, 5)) {
      lines.push(
        `${new Date(h.run_start_time).toISOString()} ${h.run_source} ${h.status} ${JSON.stringify(h.engines)}`,
      );
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- wiring

  function setup() {
    $('tree').addEventListener('click', onTreeClick);
    $('rescan').addEventListener('click', () => fetchLibrary(true));
    $('syncMissing').addEventListener('click', () => {
      const files = missingClaudesynchro().map((f) => f.path);
      if (
        files.length > 0 &&
        confirm(`Run claudesynchro on ${files.length} file(s) that have no claudesynchro result?`)
      ) {
        runFiles(files, `${files.length} file(s)`, ['claudesynchro'], false);
      }
    });
    let searchTimer;
    $('search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim().toLowerCase();
        render();
      }, 200);
    });
    $('statusFilter').addEventListener('change', (e) => {
      state.filter = e.target.value;
      render();
    });
    $('expandAll').addEventListener('click', () => {
      const walk = (node) => {
        state.expanded.add(node.path);
        state.expanded.delete(`!${node.path}`);
        node.folders.forEach(walk);
      };
      state.roots.forEach(walk);
      save('library.expanded', [...state.expanded]);
      render();
    });
    $('collapseAll').addEventListener('click', () => {
      state.expanded = new Set(state.roots.map((r) => `!${r.path}`));
      save('library.expanded', [...state.expanded]);
      render();
    });
    $('clearSelection').addEventListener('click', () => {
      state.selected.clear();
      render();
    });
    $('runSelected').addEventListener('click', async () => {
      await runFiles([...state.selected], `${state.selected.size} file(s)`);
      state.selected.clear();
      render();
    });
    $('engineChoices').addEventListener('change', () => {
      state.engines = [...$('engineChoices').querySelectorAll('input:checked')].map((i) => i.value);
      save('library.engines', state.engines);
    });

    const modal = $('detailsModal');
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.hasAttribute('data-close')) {
        modal.classList.add('hidden');
      }
    });
    $('detailsRun').addEventListener('click', () => runFiles([state.details.path], 'File'));
    $('detailsReset').addEventListener('click', async () => {
      await api('/api/skip-status/reset', { method: 'POST', body: { filePath: state.details.path } });
      toast('Failure count reset; scheduled runs will try this file again', 'success');
      await fetchLibrary(false);
      openDetails(state.details.path);
    });
    $('detailsCopy').addEventListener('click', async () => {
      await copyText(detailsAsText());
      toast('Debug info copied to the clipboard', 'success');
    });

    connectLive((msg) => {
      if (msg.type === 'file:updated') {
        const file = msg.data.file;
        setRunning(file.file_path, file.status === 'processing' ? file.current_engine || 'starting' : null);
      } else if (msg.type === 'run:started') {
        showBanner(
          `⚙ A run is in progress (${escapeHtml(msg.data.source || '')}). <a href="/">Open the dashboard</a>`,
        );
      } else if (msg.type === 'run:completed' || msg.type === 'run:cancelled') {
        showBanner('');
        state.running.clear();
        toast(`Run ${msg.type === 'run:completed' ? 'finished' : 'stopped'}; statuses updated`, 'success');
        fetchLibrary(false);
      } else if (msg.type === 'state' && msg.data.isRunning) {
        showBanner('⚙ A run is in progress. <a href="/">Open the dashboard</a>');
      }
    });

    fetchLibrary(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
