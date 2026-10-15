// Shared helpers for all Subsyncarr++ pages (navigation, API calls, formatting, toasts, live updates).
(function () {
  const TIMEZONE = 'Europe/Warsaw';
  const PAGES = [
    ['/', 'Dashboard'],
    ['/library', 'Library'],
    ['/settings', 'Settings'],
    ['/diagnostics', 'Diagnostics'],
  ];
  const ENGINE_SHORT = { ffsubsync: 'F', autosubsync: 'Au', alass: 'Al', claudesynchro: 'Cs' };

  function renderNav() {
    const nav = document.getElementById('mainNav');
    if (!nav) {
      return;
    }
    const current = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
    nav.innerHTML = PAGES.map(
      ([href, label]) => `<a href="${href}" class="nav-link${current === href ? ' active' : ''}">${label}</a>`,
    ).join('');
  }

  async function api(path, options = {}) {
    const init = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
    if (init.body && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error((data && data.error) || `HTTP ${response.status}`);
    }
    return data;
  }

  function escapeHtml(text) {
    return String(text ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, timeStyle: 'medium' });

  /** Date and time in Warsaw time. */
  function formatDateTime(value) {
    if (!value) {
      return '-';
    }
    return dateTimeFormat.format(new Date(value));
  }

  function formatTime(value) {
    return value ? timeFormat.format(new Date(value)) : '-';
  }

  function formatRelative(value) {
    const diff = new Date(value).getTime() - Date.now();
    const abs = Math.abs(diff);
    const units = [
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000],
    ];
    for (const [unit, ms] of units) {
      if (abs >= ms) {
        const n = Math.round(abs / ms);
        const text = `${n} ${unit}${n > 1 ? 's' : ''}`;
        return diff >= 0 ? `in ${text}` : `${text} ago`;
      }
    }
    return diff >= 0 ? 'in under a minute' : 'just now';
  }

  function formatBytes(bytes) {
    if (bytes == null) {
      return '?';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(ms) {
    if (ms == null) {
      return '-';
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function toast(message, type = 'info') {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for http:// pages, where the clipboard API is not available.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  /** Live events from the server; reconnects automatically. */
  function connectLive(onMessage) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onmessage = (event) => onMessage(JSON.parse(event.data));
    ws.onclose = () => setTimeout(() => connectLive(onMessage), 3000);
  }

  window.UI = {
    TIMEZONE,
    ENGINE_SHORT,
    api,
    escapeHtml,
    formatDateTime,
    formatTime,
    formatRelative,
    formatBytes,
    formatDuration,
    toast,
    copyText,
    connectLive,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNav);
  } else {
    renderNav();
  }
})();
