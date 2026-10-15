// Diagnostics page: environment, tool checks, recent errors, auto-skipped pairs, logs and the copyable report.
(function () {
  const { api, escapeHtml, formatBytes, formatDateTime, formatDuration, toast, copyText } = window.UI;
  const $ = (id) => document.getElementById(id);
  let data = null;

  function facts(pairs) {
    return pairs
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
      .join('');
  }

  function warnings(d) {
    const out = [];
    const bad = d.tools.filter((t) => !t.ok);
    if (bad.length) {
      out.push(`These tools are not working: ${bad.map((t) => t.name).join(', ')}.`);
    }
    const flags = d.system.cpuFlags;
    if (flags && !flags.avx2) {
      out.push('This CPU has no AVX2: Whisper transcription runs on slower code paths (it still works).');
    }
    const { limit, usage } = d.system.container;
    if (limit && limit < 1.5 * 1024 ** 3) {
      out.push(`Container memory limit is ${formatBytes(limit)}; claudesynchro needs about 1 GB, 2 GB is recommended.`);
    }
    if (limit && usage && usage > 0.9 * limit) {
      out.push(`Memory usage is close to the limit (${formatBytes(usage)} of ${formatBytes(limit)}).`);
    }
    for (const disk of d.system.disks) {
      if (disk.freeBytes !== null && disk.freeBytes < 2 * 1024 ** 3) {
        out.push(`Low disk space on ${disk.path}: ${formatBytes(disk.freeBytes)} free.`);
      }
    }
    const hub = d.claudesynchro && d.claudesynchro.network && d.claudesynchro.network['huggingface.co'];
    if (hub && !hub.startsWith('ok')) {
      out.push(`claudesynchro cannot download its models from huggingface.co: ${hub}`);
    }
    if (d.claudesynchro && d.claudesynchro.data_dir && !d.claudesynchro.data_dir.writable) {
      out.push(`claudesynchro cannot write to ${d.claudesynchro.data_dir.path} (models and caches go there).`);
    }
    $('warnings').innerHTML = out.map((w) => `<div class="warning-box">⚠ ${escapeHtml(w)}</div>`).join('');
  }

  function render(d) {
    data = d;
    warnings(d);
    const flags = d.system.cpuFlags
      ? Object.entries(d.system.cpuFlags)
          .map(([f, on]) => `<span class="${on ? 'ok' : 'bad'}">${f}</span>`)
          .join(' ')
      : 'n/a';
    $('system').innerHTML = facts([
      [
        'Version',
        `${escapeHtml(d.app.version)} · commit ${escapeHtml(d.app.commit)}${d.app.buildDate ? ` · built ${escapeHtml(d.app.buildDate)}` : ''}`,
      ],
      [
        'Node',
        `${escapeHtml(d.app.node)} · up ${formatDuration(d.app.uptimeSeconds * 1000)} · ${formatBytes(d.app.memory.rss)} RSS`,
      ],
      ['System', escapeHtml(d.system.platform)],
      ['CPU', `${escapeHtml(d.system.cpu)} · ${d.system.cores} cores · load ${d.system.loadAverage.join(' / ')}`],
      ['CPU features', flags],
      ['Host memory', `${formatBytes(d.system.memoryTotal)} (${formatBytes(d.system.memoryFree)} free)`],
      [
        'Container',
        d.system.container.limit
          ? `limit ${formatBytes(d.system.container.limit)} · using ${formatBytes(d.system.container.usage)}`
          : 'no memory limit detected',
      ],
      [
        'Disk space',
        d.system.disks
          .map(
            (x) =>
              `<div><span class="mono">${escapeHtml(x.path)}</span>: ${formatBytes(x.freeBytes)} free of ${formatBytes(x.totalBytes)}</div>`,
          )
          .join(''),
      ],
    ]);

    $('tools').innerHTML = d.tools
      .map(
        (t) =>
          `<tr><td>${t.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td><td>${escapeHtml(t.name)}</td><td class="mono">${escapeHtml(t.version)}</td></tr>`,
      )
      .join('');
    const cs = d.claudesynchro || {};
    $('claudesynchro').innerHTML = cs.error
      ? `<dt>Error</dt><dd><pre class="error-output">${escapeHtml(cs.error)}</pre></dd>`
      : facts([
          ['Version', escapeHtml(cs.version)],
          ['Python', escapeHtml(cs.python)],
          [
            'Packages',
            escapeHtml(
              Object.entries(cs.packages || {})
                .map(([k, v]) => `${k} ${v}`)
                .join(', '),
            ),
          ],
          [
            'Whisper on this CPU',
            escapeHtml(
              Array.isArray(cs.whisper_cpu_compute_types)
                ? cs.whisper_cpu_compute_types.join(', ')
                : cs.whisper_cpu_compute_types,
            ),
          ],
          [
            'Network',
            cs.network
              ? Object.entries(cs.network)
                  .map(
                    ([host, status]) =>
                      `<span class="${String(status).startsWith('ok') ? 'ok' : 'bad'}">${escapeHtml(host)}</span> ${escapeHtml(status)}`,
                  )
                  .join('<br>')
              : '',
          ],
          [
            'Data',
            cs.data_dir
              ? `${escapeHtml(cs.data_dir.path)} · models ${cs.data_dir.models_mb} MB · ${cs.data_dir.transcripts_cached} cached transcript(s) · ${cs.data_dir.reports} report(s)`
              : '',
          ],
          [
            'Settings',
            cs.settings
              ? escapeHtml(
                  `languages ${cs.settings.languages}, gap fill ${cs.settings.gap_fill}, whisper ${cs.settings.whisper_model}, min confidence ${cs.settings.min_confidence}, transcriber ${cs.settings.transcriber}`,
                )
              : '',
          ],
        ]);

    $('failureCount').textContent = `${d.failures.length} shown`;
    $('failures').innerHTML = d.failures.length
      ? d.failures
          .map(
            (f) => `
        <div class="failure">
          <div class="failure-head">
            <span class="pill pill-failed">${escapeHtml(f.engine)}</span>
            <span class="file-path" title="${escapeHtml(f.file)}">${escapeHtml(f.file.split('/').slice(-2).join('/'))}</span>
            <span class="muted">${f.time ? formatDateTime(f.time) : ''} · ${f.failuresInARow ? `${f.failuresInARow}× in a row` : 'setup problem, not counted'}</span>
            <button class="btn btn-secondary btn-sm" data-reset="${escapeHtml(f.file)}" data-engine="${escapeHtml(f.engine)}">Reset</button>
          </div>
          <div>${escapeHtml(f.message || '')}</div>
          ${f.details ? `<details><summary>output</summary><pre class="error-output">${escapeHtml(f.details)}</pre></details>` : ''}
        </div>`,
          )
          .join('')
      : '<p class="no-data">No errors recorded. 🎉</p>';

    $('skippedCount').textContent = `${d.autoSkipped.length} file/engine pair(s)`;
    $('skipped').innerHTML = d.autoSkipped.length
      ? `<table class="details-table"><thead><tr><th>Engine</th><th>File</th><th>Failures</th><th></th></tr></thead><tbody>${d.autoSkipped
          .map(
            (s) =>
              `<tr><td>${escapeHtml(s.engine)}</td><td class="mono" title="${escapeHtml(s.file)}">${escapeHtml(s.file)}</td><td>${s.failuresInARow}</td><td><button class="btn btn-secondary btn-sm" data-reset="${escapeHtml(s.file)}" data-engine="${escapeHtml(s.engine)}">Reset</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="no-data">Nothing is auto-skipped.</p>';

    const queue = d.state.queue.length
      ? `${d.state.queue.length} queued: ${d.state.queue.map((q) => `${q.source}${q.files ? ` (${q.files} files)` : ''}`).join(', ')}`
      : 'no queued runs';
    const runs = d.recentRuns
      .map(
        (r) =>
          `<tr><td>${formatDateTime(r.start)}</td><td>${escapeHtml(r.source || '')}</td><td>${escapeHtml(r.status)}</td><td>${r.files}</td><td>${r.completed}/${r.skipped}/${r.failed}</td><td>${r.durationSeconds != null ? formatDuration(r.durationSeconds * 1000) : '-'}</td></tr>`,
      )
      .join('');
    $('runs').innerHTML = `
      <p>Schedule: <strong>${escapeHtml(d.schedule.description || 'disabled')}</strong>${d.schedule.nextRun ? ` · next ${formatDateTime(d.schedule.nextRun)}` : ''} ·
        ${d.state.running ? '⚙ a run is in progress' : 'idle'} · ${escapeHtml(queue)}</p>
      <table class="details-table"><thead><tr><th>Started</th><th>By</th><th>Status</th><th>Files</th><th>OK/skipped/failed</th><th>Took</th></tr></thead><tbody>${runs}</tbody></table>`;

    const log = $('serverLog');
    log.textContent = d.serverLog.join('\n');
    log.scrollTop = log.scrollHeight;
  }

  async function load() {
    $('refresh').disabled = true;
    try {
      render(await api('/api/diagnostics'));
    } catch (error) {
      toast(`Could not load diagnostics: ${error.message}`, 'error');
    } finally {
      $('refresh').disabled = false;
    }
  }

  function setup() {
    $('refresh').addEventListener('click', load);
    $('copyReport').addEventListener('click', async () => {
      try {
        await copyText(await api('/api/diagnostics/report'));
        toast('Debug report copied - paste it into the chat', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('copyLog').addEventListener('click', async () => {
      await copyText(data ? data.serverLog.join('\n') : '');
      toast('Log copied', 'success');
    });
    document.body.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-reset]');
      if (!button) {
        return;
      }
      await api('/api/skip-status/reset', {
        method: 'POST',
        body: { filePath: button.dataset.reset, engine: button.dataset.engine },
      });
      toast('Reset; scheduled runs will try it again', 'success');
      load();
    });
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
