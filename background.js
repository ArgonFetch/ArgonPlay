/**
 * Argon Play - background worker.
 *
 * The one place that talks to an ArgonFetch instance. A content script cannot: it inherits
 * youtube.com as its origin and the instance's CORS policy does not list it. Here the request
 * carries the extension's own origin and the host permission waives CORS entirely.
 *
 * Self-contained on purpose - Chrome runs this as a service worker and Firefox as an event page,
 * and the two disagree about every way of loading a second file.
 */

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  instance: 'https://app.argonfetch.dev',
  maxHeight: 1080,
  preferH264: false,
  autoplay: true,
  keepVolume: 100,
};

/** Keys live an hour on the instance; stop trusting ours a little before that. */
const CACHE_TTL_MS = 45 * 60 * 1000;

/**
 * A fallback result is kept only briefly: it means the instance had no playback endpoint at the
 * time, and holding that answer for the best part of an hour would keep a freshly updated
 * instance stuck on the degraded path long after it stopped being true.
 */
const FALLBACK_TTL_MS = 60 * 1000;

/** yt-dlp is not fast, and a cold resolve on a long video can crawl. */
const RESOLVE_TIMEOUT_MS = 60_000;

/** videoId -> { at, payload } */
const cache = new Map();

/** videoId -> Promise, so two content scripts asking at once resolve once. */
const inFlight = new Map();

async function settings() {
  const stored = await api.storage.sync.get(DEFAULTS).catch(() => DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function origin(instance) {
  return String(instance || DEFAULTS.instance).trim().replace(/\/+$/, '');
}

function idOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
    if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2];
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  } catch {
    /* not a URL we know */
  }
  return null;
}

async function getJson(url, signal) {
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    let detail = '';
    try {
      const problem = await response.json();
      detail = problem.detail || problem.title || '';
    } catch {
      /* not a ProblemDetails body */
    }
    const error = new Error(detail || `The instance answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * The endpoint built for players: video and audio apart, every track served by a route that
 * declares a length and answers ranges. Instances older than this endpoint answer 404 and the
 * caller falls back.
 */
async function fetchPlayback(base, pageUrl, signal) {
  const data = await getJson(`${base}/api/Fetch/GetPlayback?url=${encodeURIComponent(pageUrl)}`, signal);

  const track = (t) => ({
    url: base + t.path,
    label: t.label,
    contentType: t.contentType,
    mimeType: t.mimeType,
    codec: t.codec ?? null,
    height: t.height ?? null,
    fps: t.fps ?? null,
    bitrate: t.bitrate ?? null,
    bytes: t.fileSizeBytes ?? null,
    seekable: true,
  });

  return {
    source: 'playback',
    title: data.title || '',
    author: data.author || '',
    cover: data.coverUrl || null,
    duration: data.durationSeconds ?? null,
    video: (data.video ?? []).map(track),
    audio: (data.audio ?? []).map(track),
    muxed: (data.muxed ?? []).map(track),

    // The instance fetches these itself. YouTube's own caption URLs answer this browser with
    // 200 and an empty body, which makes a track with no cues and reports no error at all.
    subtitles: (data.subtitles ?? []).map((s) => ({
      url: base + s.path,
      lang: s.language,
      name: s.name || s.language,
      automatic: s.automatic === true,
      source: 'instance',
    })),
  };
}

/**
 * What every published instance already serves. Its video renditions are muxed by FFmpeg while
 * the client reads them, so they carry no length and ignore ranges: playable, but the timeline
 * only reaches as far as what has arrived. Audio comes through untouched and seeks normally.
 */
async function fetchResource(base, pageUrl, signal) {
  const data = await getJson(`${base}/api/Fetch/GetResource?url=${encodeURIComponent(pageUrl)}`, signal);

  const item = (data.mediaItems ?? [])[0];
  if (!item) throw new Error('The instance resolved the link to nothing playable.');

  const track = (r, isAudio) => {
    const combined = r.urlType === 'Combined' || r.urlType === 0;
    const query = r.convertTo ? `?format=${encodeURIComponent(r.convertTo)}` : '';

    return {
      url: combined
        ? `${base}/api/Stream/Combined/${r.key}`
        : `${base}/api/Stream/Media/${r.key}${query}`,
      label: r.label,
      contentType: r.mimeType,
      mimeType: r.mimeType,
      codec: null,
      height: r.height ?? null,
      fps: null,
      bitrate: r.bitrate ?? null,
      bytes: r.fileSizeBytes ?? null,
      // FFmpeg is still writing it; there is nothing behind the playhead to seek into.
      seekable: !combined,
      muxedByServer: combined,
    };
  };

  const video = (item.video?.renditions ?? []).map((r) => track(r, false));
  const audio = (item.audio?.renditions ?? [])
    .filter((r) => !r.convertTo) // Transcoding to MP3 to play it back would only add latency.
    .map((r) => track(r, true));

  return {
    source: 'resource',
    title: item.title || '',
    author: item.author || '',
    cover: item.coverUrl || null,
    duration: null,
    // Everything this endpoint calls video already carries its own sound.
    video: [],
    audio,
    muxed: video,
  };
}

/**
 * The downloader's view of the same link: whole files, sound included, named after the video.
 * Playback wants the tracks apart; a download never does.
 */
async function fetchDownloads(base, pageUrl, signal) {
  const data = await getJson(`${base}/api/Fetch/GetResource?url=${encodeURIComponent(pageUrl)}`, signal);

  const item = (data.mediaItems ?? [])[0];
  if (!item) throw new Error('The instance resolved the link to nothing downloadable.');

  const track = (r) => {
    const combined = r.urlType === 'Combined' || r.urlType === 0;
    const query = r.convertTo ? `?format=${encodeURIComponent(r.convertTo)}` : '';

    return {
      url: combined
        ? `${base}/api/Stream/Combined/${r.key}`
        : `${base}/api/Stream/Media/${r.key}${query}`,
      label: r.label,
      extension: r.fileExtension,
      bytes: r.fileSizeBytes ?? null,
    };
  };

  return {
    title: item.title || '',
    author: item.author || '',
    video: (item.video?.renditions ?? []).map(track),
    audio: (item.audio?.renditions ?? []).map(track),
  };
}

async function downloads(pageUrl) {
  const config = await settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    return { ok: true, data: await fetchDownloads(origin(config.instance), pageUrl, controller.signal) };
  } catch (error) {
    return {
      ok: false,
      error: error.name === 'AbortError'
        ? 'The instance took too long to resolve this video.'
        : (error.message || 'The instance could not be reached.'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(pageUrl) {
  const config = await settings();
  const base = origin(config.instance);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    try {
      return await fetchPlayback(base, pageUrl, controller.signal);
    } catch (error) {
      if (error.status !== 404 && error.status !== 405) throw error;
      // An instance that predates /GetPlayback. Still usable, with a timeline that cannot seek.
      return await fetchResource(base, pageUrl, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

function cached(id) {
  const hit = cache.get(id);
  if (!hit) return null;

  const life = hit.payload.source === 'playback' ? CACHE_TTL_MS : FALLBACK_TTL_MS;

  if (Date.now() - hit.at > life) {
    cache.delete(id);
    return null;
  }

  return hit.payload;
}

async function handleResolve(pageUrl, force) {
  const config = await settings();

  // Keyed by instance as well as video: the cached payload holds that instance's stream URLs,
  // and serving them after the address changed points the player at the wrong server.
  const id = `${origin(config.instance)}#${idOf(pageUrl) ?? pageUrl}`;

  if (!force) {
    const hit = cached(id);
    if (hit) return { ok: true, data: hit, cached: true };
  }

  if (inFlight.has(id)) return inFlight.get(id);

  const pending = (async () => {
    try {
      const data = await resolve(pageUrl);
      cache.set(id, { at: Date.now(), payload: data });
      return { ok: true, data, cached: false };
    } catch (error) {
      return {
        ok: false,
        error: error.name === 'AbortError'
          ? 'The instance took too long to resolve this video.'
          : (error.message || 'The instance could not be reached.'),
      };
    } finally {
      inFlight.delete(id);
    }
  })();

  inFlight.set(id, pending);
  return pending;
}

async function reachable() {
  const config = await settings();

  try {
    const info = await getJson(`${origin(config.instance)}/api/App`);
    return { ok: true, version: info.version, maintenance: info.maintenance ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * A subtitle track, as text. It comes through here rather than from the page because a content
 * script's fetch is still subject to CORS - the host permission that waives it belongs to the
 * worker - and because the URL is checked against the configured instance on the way past, so
 * this stays a route to one server rather than a fetch-anything service.
 */
async function subtitle(url) {
  const config = await settings();
  const base = origin(config.instance);

  if (typeof url !== 'string' || !url.startsWith(`${base}/`)) {
    return { ok: false, error: 'That subtitle track is not on the configured instance.' };
  }

  try {
    const response = await fetch(url);

    if (!response.ok) return { ok: false, error: `The instance answered ${response.status}.` };

    const text = await response.text();

    if (!/\d\d:\d\d/.test(text)) return { ok: false, error: 'The track came back with no cues.' };

    return { ok: true, vtt: text };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    resolve: () => handleResolve(message.url, message.force === true),
    downloads: () => downloads(message.url),
    subtitle: () => subtitle(message.url),
    settings: async () => ({ ok: true, data: await settings() }),
    save: async () => {
      await api.storage.sync.set(message.values);
      cache.clear();
      return { ok: true };
    },
    health: () => reachable(),
    forget: async () => {
      cache.clear();
      return { ok: true };
    },
  };

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));

  return true; // The answer arrives later.
});

api.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await api.storage.sync.set(DEFAULTS);
    api.runtime.openOptionsPage?.();
  }
});
