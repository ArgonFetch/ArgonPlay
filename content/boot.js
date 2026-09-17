/**
 * Argon Play - the part that knows about YouTube.
 *
 * It never drives YouTube's player. It hides it, mounts its own in the box YouTube already sized,
 * and keeps the page's video element silent. An ad cannot interrupt a player that was never
 * started, and the streams come from an ArgonFetch instance instead of from YouTube's resolver.
 */

(() => {
  const { el, icon, ICONS, send, settings, log, size } = globalThis.Argon;

  const PLAYER_BOX = '#player-container';
  const ACTION_ROW = '#top-level-buttons-computed';

  /**
   * A row in the ... overflow menu. YouTube has moved its own download entry in there, and has
   * rewritten what those rows are made of more than once - hence the list rather than a tag name.
   */
  const MENU_ITEM = 'ytd-menu-service-item-renderer, yt-list-item-view-model, tp-yt-paper-item, [role="menuitem"]';

  const DOWNLOAD_LABELS =
    /download|herunterladen|télécharger|descargar|scarica|baixar|pobierz|下载|ダウンロード|다운로드|скачать|indir/i;

  const state = {
    id: null,
    player: null,
    config: null,
    watching: false,
    silencer: null,
    keeper: null,
    /**
     * The video the viewer handed back to YouTube. Kept because the poll below would otherwise
     * silence that player again within the second, and mount ours back over it.
     */
    handedBack: null,
    /** videoId -> { captions, upNext }, as the page-world script reported it. */
    page: new Map(),
  };

  // ------------------------------------------------------------------ the page

  function videoId(href = location.href) {
    try {
      const url = new URL(href);
      if (url.pathname === '/watch') return url.searchParams.get('v');
    } catch {
      /* not a URL */
    }
    return null;
  }

  function box() {
    return document.querySelector(PLAYER_BOX);
  }

  /**
   * YouTube's own video element, kept paused and muted for as long as we are on the page. Its
   * player is only hidden - stopping it outright means reaching into the page's own scripts, and
   * a paused element neither plays an ad nor fetches the next one.
   */
  function silence() {
    const target = document.querySelector('ytd-player video');
    if (!target) return;

    const quiet = () => {
      if (!target.paused) target.pause();
      target.muted = true;
      target.volume = 0;
    };

    quiet();

    if (state.silencer?.element === target) return;

    state.silencer?.element?.removeEventListener('play', state.silencer.handler);
    state.silencer = { element: target, handler: quiet };
    target.addEventListener('play', quiet);
  }

  // ------------------------------------------------------------------ the page's own data

  /**
   * Captions and the up-next video are already in the page, put there by YouTube under the
   * viewer's own session. The page-world script reads them and posts them here; nothing is
   * requested and nothing is authenticated.
   */
  function listenForPageData() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;

      const data = event.data;
      if (data?.channel !== 'argonplay:page' || !data.videoId) return;

      state.page.set(data.videoId, {
        captions: data.captions ?? [],
        upNext: data.upNext ?? null,
        duration: data.duration ?? null,
        chapters: data.chapters ?? [],
        storyboard: data.storyboard ?? null,
      });

      if (data.videoId === state.id && state.player) {
        state.player.describePage(state.page.get(data.videoId));
      }
    });
  }

  // ------------------------------------------------------------------ lifecycle

  async function start(id) {
    const host = box();
    if (!host) return false;

    state.id = id;
    document.documentElement.classList.add('argonplay-active');

    silence();

    if (!state.player) {
      state.player = new globalThis.Argon.Player({ onFallback: () => stop({ handBack: true }) });
      state.player.onRetry = () => resolveInto(state.player, id, { force: true });
      state.player.onNext = (next) => goTo(next);
      state.player.configure(state.config ?? {});
      state.player.mount(host);
    }

    if (state.page.has(id)) state.player.describePage(state.page.get(id));

    await resolveInto(state.player, id, { force: false });
    return true;
  }

  async function resolveInto(player, id, { force }) {
    player.working('Asking ArgonFetch for this video…');

    const response = await send({
      type: 'resolve',
      url: `https://www.youtube.com/watch?v=${id}`,
      force,
    });

    // The viewer moved on while yt-dlp was thinking.
    if (state.id !== id || !state.player) return;

    if (!response?.ok) {
      player.fail(response?.error ?? 'The instance could not be reached.');
      return;
    }

    if (!player.load(response.data)) return;

    player.root.dataset.state = 'idle';

    if (state.config?.autoplay !== false) player.play();
  }

  /**
   * Autoplay. YouTube's own router is reached by clicking a link rather than by pushState, which
   * would leave the page's data behind; a plain anchor click keeps the site a single page.
   */
  function goTo(id) {
    const link = [...document.querySelectorAll('a#thumbnail[href], a.ytd-compact-video-renderer[href]')]
      .find((anchor) => anchor.href.includes(`v=${id}`));

    if (link) {
      link.click();
      return;
    }

    location.assign(`https://www.youtube.com/watch?v=${id}`);
  }

  function stop({ handBack = false } = {}) {
    const handedId = state.id;

    state.player?.destroy();
    state.player = null;
    state.id = null;

    document.documentElement.classList.remove('argonplay-active');

    if (state.silencer) {
      state.silencer.element.removeEventListener('play', state.silencer.handler);
      state.silencer = null;
    }

    if (handBack) {
      // Give the page back a player the viewer can actually use, ads and all, and stay out of
      // its way until they move to another video.
      state.handedBack = handedId;

      const target = document.querySelector('ytd-player video');
      target?.play?.().catch(() => {});
      log('handed playback back to YouTube');
    }
  }

  // ------------------------------------------------------------------ download

  function nativeDownloadButton() {
    const explicit = document.querySelector('ytd-download-button-renderer button');
    if (explicit) return explicit;

    return [...document.querySelectorAll(`${ACTION_ROW} button`)]
      .filter((button) => !button.closest('#argonplay-download')) // not the one we added
      .find((button) => DOWNLOAD_LABELS.test(button.getAttribute('aria-label') ?? '')) ?? null;
  }

  /**
   * A button that looks like the page's own, because it is one: the Share button is copied and
   * relabelled. Writing out YouTube's class names instead would make this the first thing to
   * break the next time they rename them.
   *
   * Only the <button> is copied, into a plain wrapper of our own. Copying the yt-button-view-model
   * around it puts a second custom element into a list Polymer owns, and it deletes it again
   * within a second or two.
   */
  function cloneShareButton() {
    const share = [...document.querySelectorAll(`${ACTION_ROW} button`)]
      .find((button) => button.closest('yt-button-view-model, ytd-button-renderer'));

    if (!share) return null;

    const button = share.cloneNode(true);

    button.setAttribute('aria-label', 'Download with ArgonFetch');
    button.setAttribute('title', 'Download with ArgonFetch');

    const label = [...button.querySelectorAll('*')].find(
      (node) => node.children.length === 0 && (node.textContent ?? '').trim().length > 0,
    );

    if (label) label.textContent = 'Download';

    // The icon is rebuilt rather than edited: the copied <svg> carries the Share glyph's own
    // fill and sizing attributes, and overwriting only the path's `d` left a shape with nothing
    // to paint it with, which is why the button came out with a label and no mark.
    const existing = button.querySelector('svg');

    if (existing) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');

      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', existing.getAttribute('width') ?? '24');
      svg.setAttribute('height', existing.getAttribute('height') ?? '24');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', existing.getAttribute('class') ?? '');

      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M12 3v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L10 13.2V3zM4 19h16v2H4z');
      path.setAttribute('fill', 'currentColor');

      svg.appendChild(path);
      existing.replaceWith(svg);
    }

    // The gap between action buttons comes from the yt-button-view-model we did not copy.
    const wrap = el('div', {
      id: 'argonplay-download',
      style: { display: 'inline-flex', marginLeft: '8px' },
    }, [button]);

    return wrap;
  }

  function ensureDownloadButton() {
    const row = document.querySelector(ACTION_ROW);
    if (!row) return;

    const native = nativeDownloadButton();

    if (native) {
      native.setAttribute('title', 'Download with ArgonFetch');
      native.dataset.argonplay = 'on';
      log('took over the page download button');
      return;
    }

    if (document.getElementById('argonplay-download')) return;

    const mine = cloneShareButton();
    if (!mine) return;

    row.appendChild(mine);
    log('added a download button');
  }

  /**
   * YouTube opens its Premium sheet from a handler above the button, and capture runs top down,
   * so a listener on the button itself is already too late - the sheet is on its way before it
   * fires. This one sits at the document, which is the only place that beats them to it.
   */
  function interceptDownloadClicks() {
    document.addEventListener('click', (event) => {
      const path = event.composedPath?.() ?? [];
      const clickable = path.find((node) =>
        node instanceof HTMLElement && (node.tagName === 'BUTTON' || node.matches(MENU_ITEM)))
        ?? event.target?.closest?.(`button, ${MENU_ITEM}`);

      if (!clickable) return;

      const mine = clickable.closest('#argonplay-download');

      // In the action row the label is the aria-label; in the overflow menu it is the text of
      // the row itself, and the row is not a <button> at all.
      const inRow = clickable.closest(ACTION_ROW);
      const label = inRow
        ? clickable.getAttribute('aria-label') ?? ''
        : clickable.textContent ?? '';

      const native = clickable.closest('ytd-download-button-renderer')
        || ((inRow || clickable.closest(MENU_ITEM)) && DOWNLOAD_LABELS.test(label));

      if (!mine && !native) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Taking the click away from YouTube also takes away the thing that would have closed the
      // menu, so it would otherwise sit open behind our own panel.
      if (!inRow && !mine) closeOverflowMenu(clickable);

      openDownloads(clickable);
    }, true);
  }

  /**
   * Escape rather than a property assignment: `opened = false` on the dropdown is a Polymer
   * setter that lives in the page's world, and a content script writing that name only puts a
   * plain property on its own side of the wrapper, where nothing reads it.
   */
  function closeOverflowMenu(item) {
    const dropdown = item.closest('tp-yt-iron-dropdown')
      ?? document.querySelector('tp-yt-iron-dropdown[aria-hidden="false"]');

    // Not document as a fallback target: our own player reads Escape there.
    dropdown?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
    }));
  }

  function closeDownloads() {
    document.getElementById('argonplay-downloads')?.remove();
    document.removeEventListener('click', closeDownloads, true);
    // It is pinned to the viewport, so it would otherwise ride along with the page.
    window.removeEventListener('scroll', closeDownloads, true);
    window.removeEventListener('resize', closeDownloads, true);
  }

  async function openDownloads(anchor) {
    closeDownloads();

    const rect = anchor.getBoundingClientRect();

    const panel = el('div', {
      class: 'argonplay-downloads',
      id: 'argonplay-downloads',
      style: {
        top: `${Math.min(rect.bottom + 8, window.innerHeight - 80)}px`,
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - 280))}px`,
      },
      onclick: (event) => event.stopPropagation(),
    }, [el('div', { class: 'ap-menu-head', text: 'Asking ArgonFetch…' })]);

    document.body.appendChild(panel);

    setTimeout(() => {
      document.addEventListener('click', closeDownloads, true);
      window.addEventListener('scroll', closeDownloads, true);
      window.addEventListener('resize', closeDownloads, true);
    }, 0);

    const id = videoId();
    const response = await send({ type: 'downloads', url: `https://www.youtube.com/watch?v=${id}` });

    if (!document.body.contains(panel)) return;

    if (!response?.ok) {
      panel.replaceChildren(
        el('div', { class: 'ap-menu-head', text: 'ArgonFetch could not resolve this' }),
        el('div', { class: 'ap-menu-row', text: response?.error ?? 'Unknown error' }),
      );
      return;
    }

    const rows = [];
    const group = (title, tracks) => {
      if (tracks.length === 0) return;

      rows.push(el('div', { class: 'ap-menu-head', text: title }));

      for (const track of tracks) {
        rows.push(el('button', {
          class: 'ap-menu-row',
          type: 'button',
          onclick: () => {
            // Content-Disposition is already attachment, so the browser saves instead of playing.
            location.assign(track.url);
            closeDownloads();
          },
        }, [
          el('span', { class: 'ap-menu-label', text: track.label }),
          el('span', { class: 'ap-menu-hint', text: size(track.bytes) ?? track.extension ?? '' }),
        ]));
      }
    };

    group('Video', response.data.video);
    group('Audio', response.data.audio);

    panel.replaceChildren(...rows);
  }

  // ------------------------------------------------------------------ navigation

  async function sync() {
    state.config ??= await settings();

    const id = videoId();

    // Moving to another video clears it; staying on this one keeps YouTube's player.
    if (state.handedBack !== null && state.handedBack !== id) state.handedBack = null;

    const wanted = state.config?.enabled !== false && id !== null && state.handedBack !== id;

    if (!wanted) {
      if (state.player) stop();
      return;
    }

    if (state.id === id && state.player) {
      silence();
      ensureDownloadButton();
      return;
    }

    if (state.player) stop();

    // The box is built after the navigation event fires; wait for it rather than guessing.
    const host = await waitFor(box, 8000);

    if (!host || videoId() !== id) return;

    await start(id);
    ensureDownloadButton();
  }

  function waitFor(probe, timeout) {
    return new Promise((resolve) => {
      const found = probe();
      if (found) return resolve(found);

      const started = Date.now();
      const timer = setInterval(() => {
        const hit = probe();

        if (hit || Date.now() - started > timeout) {
          clearInterval(timer);
          resolve(hit ?? null);
        }
      }, 120);
    });
  }

  function watch() {
    // YouTube's own navigation events, and a URL check for the times they do not fire.
    for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate']) {
      window.addEventListener(event, () => sync());
    }

    let last = location.href;

    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        sync();
      } else if (videoId() && state.handedBack !== videoId()) {
        silence();
        ensureDownloadButton();
        // Theater can also be toggled by YouTube's own button or its `t` key.
        state.player?.paintTheater();
      }
    }, 1200);

    globalThis.Argon.api.storage?.onChanged?.addListener(async (changes) => {
      state.config = await settings();

      state.player?.configure(state.config ?? {});

      if ('enabled' in changes || 'instance' in changes) {
        if (state.player) stop();
        sync();
      }
    });
  }

  // Reachable from the extension's own console and from a test driver, and from nowhere else:
  // this is the content script's world, which the page cannot see into.
  globalThis.Argon.debug = state;

  listenForPageData();
  interceptDownloadClicks();
  sync();
  watch();

  log('ready');
})();
