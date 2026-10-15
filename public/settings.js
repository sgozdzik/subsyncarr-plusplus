// Settings page: daily run time (Warsaw), engines, timeouts and failure policy.
(function () {
  const { api, escapeHtml, formatDateTime, formatRelative, formatTime, toast } = window.UI;
  const ALL_ENGINES = ['ffsubsync', 'autosubsync', 'alass', 'claudesynchro'];
  const SOURCE = { ui: 'set here', env: 'from the container environment', default: 'default' };
  const $ = (id) => document.getElementById(id);

  function sourceLabel(source) {
    return `(${SOURCE[source] || source})`;
  }

  function fill(settings) {
    const schedule = settings.schedule;
    document.querySelector(`input[name=scheduleMode][value=${schedule.mode}]`).checked = true;
    if (schedule.time) {
      $('scheduleTime').value = schedule.time;
    }
    $('envCron').textContent = settings.envCron;
    $('tzName').textContent = settings.timezone;
    const info = settings.scheduleInfo;
    $('nextRun').innerHTML = info.nextRun
      ? `Next run: <strong>${formatDateTime(info.nextRun)}</strong> (${formatRelative(info.nextRun)}) · ${escapeHtml(info.description)}`
      : 'No scheduled runs.';

    $('engineList').innerHTML = ALL_ENGINES.map(
      (e) =>
        `<label class="checkbox"><input type="checkbox" value="${e}" ${settings.engines.value.includes(e) ? 'checked' : ''} /> ${e}</label>`,
    ).join('');
    $('enginesSource').textContent = sourceLabel(settings.engines.source);

    $('engineTimeout').value = settings.engineTimeoutMinutes.value;
    $('engineTimeoutSource').textContent = sourceLabel(settings.engineTimeoutMinutes.source);
    $('claudesynchroTimeout').value = settings.claudesynchroTimeoutMinutes.value;
    $('claudesynchroTimeoutSource').textContent = sourceLabel(settings.claudesynchroTimeoutMinutes.source);
    $('maxFailures').value = settings.maxFailures.value;
    $('maxFailuresSource').textContent = sourceLabel(settings.maxFailures.source);
  }

  async function loadSettings() {
    try {
      fill(await api('/api/settings'));
    } catch (error) {
      toast(`Could not load settings: ${error.message}`, 'error');
    }
  }

  async function save(body, message) {
    try {
      fill(await api('/api/settings', { method: 'PUT', body }));
      toast(message, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function setup() {
    $('settingsForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const mode = document.querySelector('input[name=scheduleMode]:checked')?.value || 'env';
      const engines = [...$('engineList').querySelectorAll('input:checked')].map((i) => i.value);
      if (engines.length === 0) {
        toast('Pick at least one engine', 'error');
        return;
      }
      save(
        {
          schedule: { mode, time: $('scheduleTime').value },
          engines,
          engineTimeoutMinutes: Number($('engineTimeout').value),
          claudesynchroTimeoutMinutes: Number($('claudesynchroTimeout').value),
          maxFailures: Number($('maxFailures').value),
        },
        'Settings saved',
      );
    });
    $('scheduleTime').addEventListener('focus', () => {
      document.querySelector('input[name=scheduleMode][value=daily]').checked = true;
    });
    $('resetDefaults').addEventListener('click', () => {
      if (confirm('Go back to the container settings (environment variables / defaults)?')) {
        save(
          {
            schedule: { mode: 'env' },
            engines: null,
            engineTimeoutMinutes: null,
            claudesynchroTimeoutMinutes: null,
            maxFailures: null,
          },
          'Settings reset to container defaults',
        );
      }
    });
    const tick = () => ($('nowWarsaw').textContent = formatTime(Date.now()));
    tick();
    setInterval(tick, 1000);
    loadSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
