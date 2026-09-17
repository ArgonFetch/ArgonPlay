/**
 * Argon Play - the page-world bridge.
 *
 * The only script that runs in YouTube's own world, and it reads rather than calls. Everything a
 * player needs beyond the media itself is already sitting in the page when it loads: the caption
 * tracks with their signed URLs, and the video the page would play next. YouTube fetched both
 * under the viewer's own session, so there is nothing to authenticate and nothing to ask for.
 *
 * Calling InnerTube instead would mean re-requesting what is already here, and /youtubei/v1/player
 * answers UNPLAYABLE without the attestation token the page's own player holds.
 *
 * It posts what it finds to the isolated world and never listens for anything: a page-world script
 * that takes instructions from the page is a way in, and this one has nothing to say back.
 */

(() => {
  const CHANNEL = 'argonplay:page';

  function captionTracks() {
    const list = globalThis.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer;

    if (!list?.captionTracks) return [];

    return list.captionTracks.map((track) => ({
      lang: track.languageCode,
      name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode,
      // "asr" is YouTube's own transcription rather than something a human wrote.
      automatic: track.kind === 'asr',
      url: track.baseUrl,
    }));
  }

  /**
   * Chapters, from whichever place this page load put them. YouTube sometimes decorates the
   * player bar with them and sometimes only fills the description panel, so both are read.
   */
  function chapters() {
    const data = globalThis.ytInitialData;

    const bar = data?.playerOverlays?.decoratedPlayerBarRenderer
      ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer;

    const marked = (bar?.markersMap ?? [])
      .find((entry) => /chapter/i.test(entry.key ?? ''))?.value?.chapters ?? [];

    if (marked.length > 0) {
      return marked
        .map((entry) => ({
          title: entry.chapterRenderer?.title?.simpleText
            ?? entry.chapterRenderer?.title?.runs?.[0]?.text ?? '',
          start: (entry.chapterRenderer?.timeRangeStartMillis ?? 0) / 1000,
        }))
        .filter((chapter) => chapter.title);
    }

    const panel = (data?.engagementPanels ?? []).find((entry) =>
      (entry.engagementPanelSectionListRenderer?.targetId ?? '').includes('macro-markers-description-chapters'));

    const items = panel?.engagementPanelSectionListRenderer?.content
      ?.macroMarkersListRenderer?.contents ?? [];

    return items
      .map((item) => {
        const renderer = item.macroMarkersListItemRenderer;

        return {
          title: renderer?.title?.simpleText ?? renderer?.title?.runs?.[0]?.text ?? '',
          start: Number(renderer?.onTap?.watchEndpoint?.startTimeSeconds ?? NaN),
        };
      })
      .filter((chapter) => chapter.title && Number.isFinite(chapter.start));
  }

  /** The sprite sheets behind the frame that appears when you hover the bar. */
  function storyboard() {
    return globalThis.ytInitialPlayerResponse?.storyboards
      ?.playerStoryboardSpecRenderer?.spec ?? null;
  }

  function upNext() {
    const sets = globalThis.ytInitialData?.contents
      ?.twoColumnWatchNextResults?.autoplay?.autoplay?.sets;

    const video = sets?.[0]?.autoplayVideo;

    return video?.watchEndpoint?.videoId ?? video?.reelWatchEndpoint?.videoId ?? null;
  }

  function videoId() {
    return globalThis.ytInitialPlayerResponse?.videoDetails?.videoId ?? null;
  }

  /**
   * How long the video is. Worth carrying even though the instance usually says so too: a stream
   * that is muxed as it is sent has no length of its own, and without this the player can only
   * show how much has arrived so far, which counts up as it goes and looks like a bug.
   */
  function duration() {
    const seconds = Number(globalThis.ytInitialPlayerResponse?.videoDetails?.lengthSeconds);

    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  function publish() {
    const id = videoId();

    if (!id) return false;

    window.postMessage({
      channel: CHANNEL,
      videoId: id,
      captions: captionTracks(),
      upNext: upNext(),
      duration: duration(),
      chapters: chapters(),
      storyboard: storyboard(),
    }, location.origin);

    return true;
  }

  // The first read usually lands before YouTube has swapped in the new page's data, so a
  // navigation is followed for a moment rather than trusted the instant it fires.
  function publishSoon() {
    let tries = 0;
    let last = null;

    const timer = setInterval(() => {
      const id = videoId();

      if (id && id !== last) {
        last = id;
        publish();
      }

      if (++tries > 40) clearInterval(timer);
    }, 250);
  }

  publish();
  publishSoon();

  for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) {
    window.addEventListener(event, publishSoon);
  }
})();
