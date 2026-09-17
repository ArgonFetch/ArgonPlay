/** Argon Play - toolbar popup: is it on, is the instance answering, and one way to retry. */

const api = globalThis.browser ?? globalThis.chrome;

const send = (message) => new Promise((resolve) => api.runtime.sendMessage(message, resolve));

const statusLine = document.getElementById('status');
const instanceLine = document.getElementById('instance');
const enabled = document.getElementById('enabled');

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function load() {
  const settings = (await send({ type: 'settings' }))?.data ?? {};

  enabled.checked = settings.enabled !== false;

  try {
    instanceLine.textContent = new URL(settings.instance).host;
    instanceLine.title = settings.instance;
  } catch {
    instanceLine.textContent = settings.instance ?? '—';
  }

  const health = await send({ type: 'health' });

  statusLine.className = `value ${health?.ok ? 'ok' : 'bad'}`;
  statusLine.textContent = health?.ok
    ? (health.maintenance ?? `Reachable ${health.version}`)
    : 'Not reachable';
  statusLine.title = health?.error ?? '';
}

enabled.addEventListener('change', async () => {
  await send({ type: 'save', values: { enabled: enabled.checked } });
});

document.getElementById('options').addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

document.getElementById('refresh').addEventListener('click', async () => {
  await send({ type: 'forget' });

  const tab = await activeTab();

  // Re-resolving means reloading the page: the content script asks again on the way up.
  if (tab?.id) api.tabs.reload(tab.id);

  window.close();
});

load();
