/** Argon Play - options. Every control writes straight through; there is no save button. */

const api = globalThis.browser ?? globalThis.chrome;

const FIELDS = {
  enabled: 'checkbox',
  instance: 'text',
  maxHeight: 'number',
  preferH264: 'checkbox',
  autoplay: 'checkbox',
  keepVolume: 'number',
};

const health = document.getElementById('health');
const saved = document.getElementById('saved');
const volumeOut = document.getElementById('volumeOut');

function send(message) {
  return new Promise((resolve) => api.runtime.sendMessage(message, resolve));
}

function read(id, kind) {
  const node = document.getElementById(id);
  if (kind === 'checkbox') return node.checked;
  if (kind === 'number') return Number(node.value);
  return node.value.trim();
}

function write(id, kind, value) {
  const node = document.getElementById(id);
  if (kind === 'checkbox') node.checked = value !== false;
  else node.value = String(value ?? '');
}

function flash() {
  saved.classList.add('is-shown');
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => saved.classList.remove('is-shown'), 1100);
}

/**
 * The worker can only reach an instance the extension holds a host permission for - without one
 * the browser applies CORS and the instance, which lists youtube.com rather than us, refuses.
 * Only app.argonfetch.dev is granted at install, so any other address has to be asked for, and
 * asking has to happen inside a click.
 */
async function allow(instance) {
  let pattern;

  try {
    pattern = `${new URL(instance).origin}/*`;
  } catch {
    return false;
  }

  if (await api.permissions.contains({ origins: [pattern] })) return true;

  try {
    return await api.permissions.request({ origins: [pattern] });
  } catch {
    return false; // not called from a gesture, or the user said no
  }
}

async function persist({ ask = false } = {}) {
  const values = {};

  for (const [id, kind] of Object.entries(FIELDS)) values[id] = read(id, kind);

  // An instance that cannot be reached is worse than no setting at all, so an empty box falls
  // back to the public one rather than being stored as ''.
  if (!values.instance) values.instance = 'https://app.argonfetch.dev';

  await send({ type: 'save', values });

  const granted = await allow(values.instance);

  if (!granted) {
    health.className = 'health bad';
    health.textContent = ask
      ? 'Argon Play needs permission to reach that address. Press Test again and allow it.'
      : 'Press Test to allow Argon Play to reach that address.';
  }

  flash();

  return granted;
}

async function check() {
  health.className = 'health';
  health.textContent = 'Checking…';

  if (!await persist({ ask: true })) return;

  const result = await send({ type: 'health' });

  if (result?.ok) {
    health.className = 'health ok';
    health.textContent = result.maintenance
      ? `Reachable, ${result.version} — busy: ${result.maintenance}`
      : `Reachable, ${result.version}`;
  } else {
    health.className = 'health bad';
    health.textContent = result?.error ?? 'No answer from that address.';
  }
}

async function load() {
  const response = await send({ type: 'settings' });
  const config = response?.data ?? {};

  for (const [id, kind] of Object.entries(FIELDS)) write(id, kind, config[id]);

  volumeOut.textContent = `${config.keepVolume ?? 100}%`;
}

for (const id of Object.keys(FIELDS)) {
  document.getElementById(id).addEventListener('change', persist);
}

document.getElementById('keepVolume').addEventListener('input', (event) => {
  volumeOut.textContent = `${event.target.value}%`;
});

document.getElementById('test').addEventListener('click', check);

load();
