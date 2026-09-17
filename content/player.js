/**
 * Argon Play - the player.
 *
 * YouTube keeps its best pictures as video-only streams with the sound stored separately, so a
 * player that wants 1080p has two files to play at once. This one drives a <video> and an
 * <audio> as a pair: the video is the clock, the audio is corrected towards it, and neither is
 * allowed to run while the other is starved. When the instance offers a stream that already
 * carries both, the audio element is left out of it.
 *
 * The chrome is built to YouTube's measurements, read off the running player rather than guessed
 * at - same bar heights, same hover growth, the same settings panel that resizes and slides
 * between its sub-menus, the same icons. A viewer should not have to learn a second player to
 * watch the same site. What differs is the accent, which is ArgonFetch's purple.
 */

(() => {
  const { el, icon, ICONS, time, size, log } = globalThis.Argon;

  /** Past this the two are audibly apart, and a jump costs less than the drift. */
  const HARD_RESYNC_SECONDS = 0.25;

  /** Under this, correcting at all would be more audible than the error. */
  const IGNORE_DRIFT_SECONDS = 0.02;

  /** Enough to close a small gap within a second or two, too little to hear as a pitch change. */
  const MAX_RATE_NUDGE = 0.05;

  /** What YouTube waits before it hides the bar and the cursor. */
  const CHROME_IDLE_MS = 3000;

  /** The clock has not moved for this long while playing: something is waiting on the network. */
  const STALL_AFTER_MS = 500;

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /** .ytp-popup-animating - what the settings menu resizes and slides in. */
  const PANEL_MS = 250;

  /** Ambient mode repaints at this rate. YouTube samples slowly too; the blur hides the rest. */
  const AMBIENT_MS = 120;

  class Player {
    constructor({ onFallback } = {}) {
      this.onFallback = onFallback;
      this.wantPlaying = false;
      this.internal = false;
      this.scrubbing = false;
      this.destroyed = false;
      this.seekable = true;
      this.videoTrack = null;
      this.audioTrack = null;
      this.tracks = { video: [], audio: [], muxed: [] };
      this.declaredDuration = null;
      this.lastTime = 0;
      this.lastAdvance = Date.now();

      // What the page told us about itself: caption tracks and the video it would play next.
      this.captions = [];
      this.caption = null;
      this.upNext = null;
      this.chapters = [];
      this.board = null;
      this.segmentNodes = null;

      this.ambient = false;
      this.autoplay = true;
      this.currentPanel = null;

      this.build();
    }

    // ---------------------------------------------------------------- construction

    build() {
      this.video = el('video', { class: 'ap-video', playsinline: '', preload: 'auto' });
      this.video.muted = true; // A video-only track has nothing to mute; a muxed one must be.

      this.audio = el('audio', { class: 'ap-audio', preload: 'auto' });

      this.poster = el('div', { class: 'ap-poster' });

      // Ambient mode. YouTube paints this from its own video element, which Argon Play hides, so
      // the glow has to be redrawn from ours or it simply disappears for anyone who had it on.
      this.ambientCanvas = el('canvas', { class: 'ap-ambient', width: '48', height: '27' });
      this.spinner = el('div', { class: 'ap-spinner' }, [el('div', { class: 'ap-spinner-ring' })]);

      this.largePlay = el('button', {
        class: 'ap-large-play',
        type: 'button',
        'aria-label': 'Play',
        onclick: (event) => {
          event.stopPropagation();
          this.toggle();
        },
      }, [this.largePlayShape()]);

      // Two separate things, as in YouTube's player: a round plate in the middle carrying the
      // icon, and a line of text a tenth of the way down the picture.
      this.bezelIcon = el('div', { class: 'ap-bezel-icon' });
      this.bezel = el('div', { class: 'ap-bezel' }, [this.bezelIcon]);

      this.bezelText = el('div', { class: 'ap-bezel-text' });
      this.bezelTextWrap = el('div', { class: 'ap-bezel-text-wrap' }, [this.bezelText]);

      this.status = el('div', { class: 'ap-status' });

      this.stage = el('div', { class: 'ap-stage' }, [
        this.poster,
        this.video,
        this.audio,
        this.spinner,
        this.largePlay,
        this.bezel,
        this.bezelTextWrap,
        this.status,
      ]);

      this.buildChrome();

      this.root = el('div', {
        class: 'argonplay',
        tabindex: '0',
        'data-state': 'idle',
      }, [
        // No gradient plates: the player YouTube currently ships carries
        // ytp-disable-bottom-gradient, and leans on the frosted pills and the drop shadow under
        // each icon for contrast instead.
        this.ambientCanvas,
        this.stage,
        this.topbar,
        this.settings,
        this.chrome,
      ]);

      this.wire();
    }

    /**
     * YouTube's big button sits in a rounded plate that takes the accent on hover. The plate is a
     * plain rounded rectangle here rather than their logo silhouette, which is a trademark.
     */
    largePlayShape() {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');

      svg.setAttribute('viewBox', '0 0 68 48');
      svg.setAttribute('width', '68');
      svg.setAttribute('height', '48');
      svg.setAttribute('aria-hidden', 'true');

      const plate = document.createElementNS(ns, 'rect');
      plate.setAttribute('class', 'ap-large-play-plate');
      plate.setAttribute('x', '0');
      plate.setAttribute('y', '0');
      plate.setAttribute('width', '68');
      plate.setAttribute('height', '48');
      plate.setAttribute('rx', '14');

      const mark = document.createElementNS(ns, 'path');
      mark.setAttribute('class', 'ap-large-play-mark');
      mark.setAttribute('d', 'M 45,24 27,14 27,34');

      svg.append(plate, mark);

      return svg;
    }

    buildChrome() {
      this.badge = el('div', { class: 'ap-badge' }, [
        icon(ICONS.argon, { size: 14 }),
        el('span', { class: 'ap-badge-name', text: 'Argon Play' }),
        el('span', { class: 'ap-badge-quality' }),
      ]);

      this.qualityBadge = this.badge.querySelector('.ap-badge-quality');
      this.topbar = el('div', { class: 'ap-chrome-top' }, [this.badge]);

      // ---- progress

      // Widths are driven by scaleX rather than by width, the way YouTube does it: the compositor
      // handles a transform on its own and the bar keeps up on a page that is otherwise busy.
      this.buffered = el('div', { class: 'ap-load-progress' });
      this.hoverFill = el('div', { class: 'ap-hover-progress' });
      this.played = el('div', { class: 'ap-play-progress' });

      this.scrubber = el('div', { class: 'ap-scrubber-button' });
      this.scrubberBox = el('div', { class: 'ap-scrubber-container' }, [this.scrubber]);

      // The preview that rides above the bar: a frame from the storyboard, the time, and the
      // chapter it falls in - the same three things YouTube shows.
      this.previewFrame = el('div', { class: 'ap-preview-frame' });
      this.previewTime = el('div', { class: 'ap-preview-time' });
      this.previewChapter = el('div', { class: 'ap-preview-chapter' });

      this.preview = el('div', { class: 'ap-preview' }, [
        this.previewFrame,
        el('div', { class: 'ap-preview-meta' }, [this.previewChapter, this.previewTime]),
      ]);

      this.tooltip = el('div', { class: 'ap-tooltip' });

      // One list when the video has no chapters, one per chapter when it does.
      this.segments = el('div', { class: 'ap-progress-segments' });

      this.bar = el('div', { class: 'ap-progress-bar' }, [this.segments, this.scrubberBox]);

      this.progress = el('div', {
        class: 'ap-progress-container',
        role: 'slider',
        'aria-label': 'Seek',
        onpointerdown: (event) => this.startScrub(event),
        onpointermove: (event) => this.hoverScrub(event),
        onpointerleave: () => this.hidePreview(),
      }, [
        el('div', { class: 'ap-progress-padding' }),
        this.bar,
        this.preview,
        this.tooltip,
      ]);

      // ---- controls

      this.playButton = this.button(ICONS.play, 'Play (k)', () => this.toggle());

      this.volumeButton = this.button(ICONS.volume, 'Mute (m)', () => this.toggleMute());

      this.volumeSlider = el('input', {
        class: 'ap-volume-slider',
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: '100',
        'aria-label': 'Volume',
        oninput: (event) => this.setVolume(Number(event.target.value) / 100, { fromUser: true }),
      });

      this.volumePanel = el('div', { class: 'ap-volume-panel' }, [this.volumeSlider]);

      this.timeDisplay = el('div', { class: 'ap-time' }, [
        el('span', { class: 'ap-time-now', text: '0:00' }),
        el('span', { class: 'ap-time-sep', text: ' / ' }),
        el('span', { class: 'ap-time-end', text: '0:00' }),
      ]);

      // The chapter you are in, shown next to the clock the way YouTube shows it.
      this.chapterLabel = el('span', { class: 'ap-chapter-label' });

      this.chapterName = el('button', {
        class: 'ap-chapter-name',
        type: 'button',
        hidden: '',
        onclick: (event) => {
          event.stopPropagation();
          this.panel = 'chapters';
          if (!this.settings.classList.contains('is-open')) this.toggleSettings();
          else this.showPanel('chapters', 'forward');
        },
      }, [this.chapterLabel, icon(ICONS.chevron, { size: 14 })]);

      this.settingsButton = this.button(ICONS.gear, 'Settings', (event) => {
        event.stopPropagation();
        this.toggleSettings();
      });

      this.pipButton = this.button(ICONS.pip, 'Miniplayer (i)', () => this.togglePip());
      this.theaterButton = this.button(ICONS.theater, 'Theater mode (t)', () => this.toggleTheater());
      this.fullscreenButton = this.button(ICONS.expand, 'Full screen (f)', () => this.toggleFullscreen());

      this.captionButton = this.button(ICONS.subtitles, 'Subtitles (c)', () => this.toggleCaptions());
      this.captionButton.style.display = 'none'; // until the page says there are any

      // .ytp-popup > .ytp-popup-content > .ytp-panel: the outer box animates its own size while
      // the panels inside slide, so the two jobs stay apart.
      this.popup = el('div', { class: 'ap-popup-content' });

      this.settings = el('div', {
        class: 'ap-settings',
        role: 'menu',
        onclick: (event) => event.stopPropagation(),
      }, [this.popup]);

      this.chrome = el('div', { class: 'ap-chrome-bottom' }, [
        this.progress,
        el('div', { class: 'ap-controls' }, [
          el('div', { class: 'ap-controls-left' }, [
            this.playButton,
            el('div', { class: 'ap-volume-area' }, [this.volumeButton, this.volumePanel]),
            this.timeDisplay,
            this.chapterName,
          ]),
          el('div', { class: 'ap-controls-right' }, [
            this.captionButton,
            this.settingsButton,
            this.pipButton,
            this.theaterButton,
            this.fullscreenButton,
          ]),
        ]),
      ]);
    }

    button(path, label, onClick) {
      return el('button', {
        class: 'ap-button',
        type: 'button',
        title: label,
        'aria-label': label,
        onclick: onClick,
      }, [icon(path, { size: 24 })]);
    }

    // ---------------------------------------------------------------- wiring

    wire() {
      const v = this.video;
      const a = this.audio;

      v.addEventListener('timeupdate', () => this.paint());
      v.addEventListener('progress', () => this.paintBuffer());
      v.addEventListener('durationchange', () => {
        this.buildSegments();
        this.paint();
      });
      v.addEventListener('loadedmetadata', () => {
        this.paint();
        this.fitVideo();
      });
      v.addEventListener('resize', () => this.fitVideo());

      v.addEventListener('ratechange', () => {
        if (!this.internal) a.playbackRate = v.playbackRate;
      });

      v.addEventListener('play', () => {
        if (this.internal) return;
        this.wantPlaying = true;
        this.resume();
        this.paintPlayButton();
      });

      v.addEventListener('pause', () => {
        if (this.internal) return;
        this.wantPlaying = false;
        this.halt();
        this.root.dataset.state = 'idle';
        this.paintPlayButton();
      });

      v.addEventListener('seeking', () => this.align({ hard: true }));
      v.addEventListener('seeked', () => {
        this.align({ hard: true });
        this.lastAdvance = Date.now();
      });

      v.addEventListener('ended', () => {
        this.wantPlaying = false;
        this.audio.pause();
        this.root.dataset.state = 'ended';
        this.paintPlayButton();

        // The page told us what it would have played next; going there is the whole feature.
        if (this.autoplay && this.upNext) this.onNext?.(this.upNext);
      });

      v.addEventListener('error', () => this.fail(this.describeError(v.error, 'video')));
      a.addEventListener('error', () => this.fail(this.describeError(a.error, 'audio')));

      this.root.addEventListener('click', (event) => {
        if (event.target.closest('.ap-chrome-bottom, .ap-settings, .ap-chrome-top')) return;
        if (this.settings.classList.contains('is-open')) {
          this.closeSettings();
          return;
        }
        this.toggle();
      });

      this.root.addEventListener('dblclick', (event) => {
        if (event.target.closest('.ap-chrome-bottom, .ap-settings, .ap-chrome-top')) return;
        this.toggleFullscreen();
      });

      this.root.addEventListener('mousemove', () => this.wake());
      this.root.addEventListener('mouseleave', () => this.sleep());
      this.root.addEventListener('keydown', (event) => this.key(event));

      document.addEventListener('fullscreenchange', () => this.paintFullscreen());

      // A click anywhere that is not the menu or the button that opened it closes the menu -
      // including outside the player, which a listener on the player alone would never see.
      this.dismiss = (event) => {
        if (!this.settings.classList.contains('is-open')) return;
        if (event.target.closest?.('.ap-settings, [title="Settings"]')) return;

        this.closeSettings();
      };

      document.addEventListener('pointerdown', this.dismiss, true);

      // Leaving the page with a menu open should not bring it back on return.
      this.hidden = () => {
        if (document.visibilityState === 'hidden') this.closeSettings();
      };

      document.addEventListener('visibilitychange', this.hidden);

      this.escape = (event) => {
        if (event.key !== 'Escape' || !this.settings.classList.contains('is-open')) return;

        this.closeSettings();
        event.stopPropagation();
      };

      document.addEventListener('keydown', this.escape, true);

      this.ticker = setInterval(() => this.tick(), 250);

      // Theater mode, a window resize, full screen: the fitted size has to follow the box.
      this.resizer = new ResizeObserver(() => this.fitVideo());
      this.resizer.observe(this.root);

      this.paintFullscreen();
      this.paintTheater();
      this.paint();
    }

    // ---------------------------------------------------------------- loading

    /** @param {object} media resolved by the background worker */
    load(media) {
      this.media = media;
      this.tracks = {
        video: media.video ?? [],
        audio: media.audio ?? [],
        muxed: media.muxed ?? [],
      };
      this.declaredDuration = media.duration ?? null;

      // Only the playback endpoint's instance understands ?start=, and only it serves streams
      // that answer ranges. An instance old enough to need the fallback can do neither, so the
      // player must not pretend otherwise.
      this.canRestart = media.source === 'playback';
      this.degraded = media.source !== 'playback';

      this.root.classList.toggle('is-degraded', this.degraded);

      if (media.cover) this.poster.style.backgroundImage = `url("${media.cover}")`;

      const chosen = globalThis.Argon.pickVideo(this.tracks.video, this.options ?? {});
      const sound = globalThis.Argon.pickAudio(this.tracks.audio);

      if (chosen && sound) {
        this.apply(chosen, sound);
        return true;
      }

      // No pair this browser can decode. A stream that already carries both is slower to start
      // and cannot always seek, but it plays.
      const single = globalThis.Argon.pickVideo(this.tracks.muxed, this.options ?? {});

      if (single) {
        this.apply(single, null);
        return true;
      }

      this.fail('None of the streams this instance offered can be decoded here.');
      return false;
    }

    apply(videoTrack, audioTrack) {
      const resumeAt = this.video.currentTime || 0;
      const wasPlaying = this.wantPlaying;

      this.videoTrack = videoTrack;
      this.audioTrack = audioTrack;
      this.seekable = videoTrack.seekable !== false;
      this.streamOffset = 0;

      this.internal = true;

      // The sound is held still while the picture is swapped. Left running it walks a few hundred
      // milliseconds ahead of a video element that is still fetching its first frames, and the
      // correction afterwards is heard. The tick starts it again, aligned, once the video is ready.
      if (this.audioTrack) this.audio.pause();

      this.video.src = videoTrack.url;
      this.video.muted = audioTrack ? true : this.muted === true;

      if (audioTrack && audioTrack.url !== this.audio.getAttribute('src')) {
        this.audio.src = audioTrack.url;
        this.audio.load();
      } else if (!audioTrack) {
        this.audio.removeAttribute('src');
        this.audio.load();
      }

      this.video.load();
      this.internal = false;

      this.setVolume(this.volume ?? 1);

      if (resumeAt > 0 && this.seekable) {
        const restore = () => {
          this.video.currentTime = resumeAt;
          this.video.removeEventListener('loadedmetadata', restore);
        };
        this.video.addEventListener('loadedmetadata', restore);
      }

      // load() empties the element, text tracks included, so a chosen subtitle is put back.
      if (this.caption) {
        const chosen = this.caption;
        this.caption = null;
        this.setCaption(chosen);
      }

      this.qualityBadge.textContent = videoTrack.label ?? '';
      // A restartable stream cannot range-seek but can still be jumped around, so the bar stays live.
      this.root.dataset.seekable = String(this.seekable || this.canRestart === true);
      this.root.dataset.state = 'buffering';
      this.lastAdvance = Date.now();

      this.buildSettings();
      this.paint();

      if (wasPlaying) this.play();

      log('playing', videoTrack.label, audioTrack ? `+ ${audioTrack.label}` : '(muxed)');
    }

    configure(options) {
      this.options = options;

      if (typeof options?.keepVolume === 'number' && this.volume === undefined) {
        this.setVolume(Math.min(1, Math.max(0, options.keepVolume / 100)));
      }
    }

    // ---------------------------------------------------------------- transport

    play() {
      this.wantPlaying = true;
      this.lastAdvance = Date.now();

      const started = this.video.play();

      if (started?.catch) {
        started.catch((error) => {
          // Autoplay with sound is refused until the tab has been interacted with. Saying so is
          // better than a player that silently does nothing.
          if (error?.name === 'NotAllowedError') {
            this.wantPlaying = false;
            this.root.dataset.state = 'idle';
            this.paintPlayButton();
          }
        });
      }

      this.resume();
      this.paintPlayButton();
    }

    pause() {
      this.wantPlaying = false;
      this.internal = true;
      this.video.pause();
      this.internal = false;
      this.halt();
      this.root.dataset.state = 'idle';
      this.paintPlayButton();
    }

    toggle() {
      if (this.root.dataset.state === 'error') return;

      if (this.wantPlaying) {
        this.pause();
        this.flash(ICONS.pause);
      } else {
        this.play();
        this.flash(ICONS.play);
      }
    }

    seek(to) {
      const end = this.duration();
      const target = Math.max(0, Math.min(Number.isFinite(end) ? end - 0.25 : to, to));

      if (this.seekable) {
        this.video.currentTime = target;
        this.align({ hard: true });
        return;
      }

      this.restartAt(target);
    }

    /**
     * Seeking a stream the server muxes as it sends it. There is nothing behind the playhead to
     * jump into, so the client asks for a new stream that begins where it wants to be and keeps
     * the offset to add back onto the element's clock.
     *
     * An instance too old to understand ?start= simply replays from the beginning, so the
     * position is checked afterwards and the attempt is given up on rather than looping.
     */
    restartAt(seconds) {
      if (!this.canRestart) {
        this.flash(ICONS.forward, 'This instance cannot seek');
        this.notice('This instance muxes as it sends, so it cannot seek. Update ArgonFetch.');
        return;
      }

      const wasPlaying = this.wantPlaying;
      const base = this.videoTrack.url.split('?')[0];

      this.streamOffset = seconds;
      this.root.dataset.state = 'buffering';

      this.internal = true;
      this.video.src = `${base}?start=${seconds.toFixed(3)}`;
      this.video.load();
      this.internal = false;

      this.paint();

      if (wasPlaying) this.play();
    }

    nudge(seconds) {
      this.seek(this.at() + seconds);
      this.flash(seconds > 0 ? ICONS.forward : ICONS.back, `${seconds > 0 ? '+' : ''}${seconds}s`);
    }

    /**
     * What the page says first, then what the instance said, and only then the element's own
     * idea. A stream that is muxed as it is sent reports the length of what has arrived so far,
     * which climbs while it plays - true, and useless as a total.
     */
    duration() {
      if (Number.isFinite(this.pageDuration) && this.pageDuration > 0) return this.pageDuration;
      if (Number.isFinite(this.declaredDuration) && this.declaredDuration > 0) return this.declaredDuration;

      const own = this.video.duration;

      return Number.isFinite(own) && own > 0 ? own : NaN;
    }

    /** Where the viewer is, which for a restarted mux is the offset plus the element's clock. */
    at() {
      return (this.streamOffset ?? 0) + (this.video.currentTime || 0);
    }

    // ---------------------------------------------------------------- the pair

    /** Audio follows the clock, without letting its own events bounce back. */
    align({ hard = false } = {}) {
      if (!this.audioTrack) return;

      const drift = this.audio.currentTime - this.video.currentTime;

      if (hard || Math.abs(drift) > HARD_RESYNC_SECONDS) {
        this.audio.currentTime = this.video.currentTime;
        this.audio.playbackRate = this.video.playbackRate;
      }
    }

    resume() {
      if (!this.audioTrack) return;
      this.align({ hard: true });
      this.audio.play().catch(() => { /* the video element reports the real failure */ });
    }

    halt() {
      if (this.audioTrack) this.audio.pause();
    }

    /**
     * One tick does three things: keep the two elements together, notice when the clock has
     * stopped moving, and keep the bar honest about it. Small errors are walked off by playing
     * the audio a fraction fast or slow, because a jump for them would be heard and a five
     * percent rate change for half a second is not.
     */
    tick() {
      if (this.destroyed) return;

      const now = this.video.currentTime;

      if (Math.abs(now - this.lastTime) > 0.001) {
        this.lastTime = now;
        this.lastAdvance = Date.now();
      }

      if (this.root.dataset.state !== 'error' && this.root.dataset.state !== 'ended') {
        const waiting = this.wantPlaying && Date.now() - this.lastAdvance > STALL_AFTER_MS;

        this.root.dataset.state = waiting ? 'buffering' : this.wantPlaying ? 'playing' : 'idle';
      }

      // A pair that drifted apart while one of them was starved is put back together as soon as
      // both have data again, rather than on a timer of its own.
      if (this.wantPlaying && this.audioTrack && this.audio.paused && this.video.readyState >= 3) {
        this.resume();
      }

      if (!this.audioTrack || this.video.paused) return;

      const drift = this.audio.currentTime - this.video.currentTime;
      const magnitude = Math.abs(drift);

      if (magnitude > HARD_RESYNC_SECONDS) {
        this.audio.currentTime = this.video.currentTime;
        this.audio.playbackRate = this.video.playbackRate;
        return;
      }

      if (magnitude < IGNORE_DRIFT_SECONDS) {
        this.audio.playbackRate = this.video.playbackRate;
        return;
      }

      const correction = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, -drift));
      this.audio.playbackRate = this.video.playbackRate * (1 + correction);
    }

    // ---------------------------------------------------------------- sound

    setVolume(level, { fromUser = false } = {}) {
      this.volume = Math.min(1, Math.max(0, level));
      this.muted = this.volume === 0;

      const sink = this.audioTrack ? this.audio : this.video;

      sink.volume = this.volume;
      sink.muted = this.muted;

      if (this.audioTrack) this.video.muted = true;

      this.volumeSlider.value = String(Math.round(this.volume * 100));
      this.volumeSlider.style.setProperty('--ap-filled', `${Math.round(this.volume * 100)}%`);
      this.paintVolume();

      if (fromUser) {
        this.flash(this.muted ? ICONS.muted : ICONS.volume, `${Math.round(this.volume * 100)}%`);
      }
    }

    toggleMute() {
      if (this.muted || this.volume === 0) {
        this.setVolume(this.lastVolume || 1, { fromUser: true });
      } else {
        this.lastVolume = this.volume;
        this.setVolume(0, { fromUser: true });
      }
    }

    setSpeed(rate) {
      this.internal = true;
      this.video.playbackRate = rate;
      this.audio.playbackRate = rate;
      this.internal = false;

      this.buildSettings();
      this.flash(ICONS.gear, `${rate}×`);
    }

    // ---------------------------------------------------------------- views

    async togglePip() {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await this.video.requestPictureInPicture();
      } catch {
        this.flash(ICONS.pip, 'Unavailable');
      }
    }

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else this.root.requestFullscreen?.().catch(() => this.flash(ICONS.expand, 'Refused'));
    }

    /**
     * Theater mode belongs to the page, not to the player: it is the watch layout that widens,
     * and YouTube drives it off its own size button. Hidden is not disabled, so clicking that
     * button still works and the page rearranges itself exactly as it always did.
     */
    toggleTheater() {
      const button = document.querySelector('.ytp-size-button');

      if (!button) {
        this.flash(ICONS.theater, 'Unavailable here');
        return;
      }

      button.click();
      this.paintTheater();
    }

    theaterOn() {
      return document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') === true;
    }

    paintTheater() {
      // The attribute lands after YouTube has re-laid the page out.
      setTimeout(() => {
        const on = this.theaterOn();

        this.theaterButton.classList.toggle('is-active', on);
        this.theaterButton.setAttribute('aria-pressed', String(on));
        this.theaterButton.title = on ? 'Default view (t)' : 'Theater mode (t)';

        this.fitVideo();
      }, 120);
    }

    paintFullscreen() {
      const full = document.fullscreenElement === this.root;

      this.root.classList.toggle('is-fullscreen', full);
      this.fullscreenButton.replaceChildren(icon(full ? ICONS.collapse : ICONS.expand, { size: 24 }));
      this.fullscreenButton.title = full ? 'Exit full screen (f)' : 'Full screen (f)';
    }

    // ---------------------------------------------------------------- scrubbing

    ratioAt(event) {
      const box = this.bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    }

    /** One place that knows the bar is driven by transforms, so the rest can speak in ratios. */
    place(ratio) {
      this.played.style.transform = `scaleX(${ratio})`;
      this.scrubberBox.style.transform = `translateX(${this.bar.clientWidth * ratio}px)`;
    }

    startScrub(event) {
      const end = this.duration();

      if (!Number.isFinite(end)) return;
      if (!this.seekable && this.canRestart !== true) return;

      this.scrubbing = true;
      this.root.classList.add('is-scrubbing');
      this.progress.setPointerCapture(event.pointerId);

      const move = (moveEvent) => {
        const ratio = this.ratioAt(moveEvent);

        this.place(ratio);
        this.timeDisplay.querySelector('.ap-time-now').textContent = time(ratio * end);
        this.hoverScrub(moveEvent);
      };

      const up = (upEvent) => {
        this.scrubbing = false;
        this.root.classList.remove('is-scrubbing');
        this.progress.releasePointerCapture?.(upEvent.pointerId);
        this.progress.removeEventListener('pointermove', move);
        this.progress.removeEventListener('pointerup', up);
        this.seek(this.ratioAt(upEvent) * end);
      };

      this.progress.addEventListener('pointermove', move);
      this.progress.addEventListener('pointerup', up);

      move(event);
    }

    hoverScrub(event) {
      const end = this.duration();

      if (!Number.isFinite(end)) return;
      if (!this.seekable && this.canRestart !== true) return;

      const ratio = this.ratioAt(event);

      this.hoverAt = ratio * end;
      this.paintSegments(this.at(), 0);
      this.paintPreview(ratio, end);
    }

    hidePreview() {
      this.preview.classList.remove('is-shown');
      this.tooltip.classList.remove('is-shown');
      this.hoverAt = undefined;

      for (const segment of this.segmentNodes ?? []) {
        segment.hover.style.transform = 'scaleX(0)';
      }
    }

    // ---------------------------------------------------------------- painting

    paint() {
      if (this.scrubbing) return;

      const now = this.at();
      const end = this.duration();
      const ratio = Number.isFinite(end) && end > 0 ? Math.min(1, now / end) : 0;

      this.place(ratio);

      const buffered = this.video.buffered;
      const ahead = buffered.length > 0
        ? (this.streamOffset ?? 0) + buffered.end(buffered.length - 1)
        : 0;

      this.paintSegments(now, ahead);
      this.paintChapterName();

      this.timeDisplay.querySelector('.ap-time-now').textContent = time(now);
      this.timeDisplay.querySelector('.ap-time-end').textContent = Number.isFinite(end) ? time(end) : '--:--';

      this.paintBuffer();
      this.paintPlayButton();
    }

    paintBuffer() {
      const end = this.duration();
      if (!Number.isFinite(end) || end <= 0 || this.video.buffered.length === 0) return;

      const ahead = (this.streamOffset ?? 0) + this.video.buffered.end(this.video.buffered.length - 1);
      this.buffered.style.transform = `scaleX(${Math.min(1, ahead / end)})`;
    }

    /**
     * Play and pause are one path morphing into the other. YouTube ships both shapes normalised
     * to the same segment topology precisely so this works - which is why the play triangle's
     * path data looks so redundant written out - and SMIL animates `d` in both engines, where the
     * CSS `d` property is Chrome only.
     */
    paintPlayButton() {
      const ended = this.root.dataset.state === 'ended';
      const next = ended ? ICONS.replay : this.wantPlaying ? ICONS.pause : ICONS.play;

      this.playButton.title = this.wantPlaying ? 'Pause (k)' : 'Play (k)';

      if (this.playShape === next) return;

      const morphable = (a, b) => a && b && !a.stroke && !b.stroke && a.d.length === b.d.length;
      const from = this.playShape;

      this.playShape = next;

      if (!morphable(from, next)) {
        this.playButton.replaceChildren(icon(next, { size: 24 }));
        return;
      }

      const paths = [...this.playButton.querySelectorAll('path')];

      paths.forEach((path, index) => {
        path.replaceChildren();

        const animate = document.createElementNS('http://www.w3.org/2000/svg', 'animate');

        animate.setAttribute('attributeName', 'd');
        animate.setAttribute('from', from.d[index]);
        animate.setAttribute('to', next.d[index]);
        animate.setAttribute('dur', '0.2s');
        animate.setAttribute('calcMode', 'spline');
        animate.setAttribute('keySplines', '0 0 0.2 1');
        animate.setAttribute('keyTimes', '0;1');
        animate.setAttribute('fill', 'freeze');

        path.appendChild(animate);
        animate.beginElement?.();

        // Whatever the engine did with the animation, the attribute ends up correct.
        setTimeout(() => path.setAttribute('d', next.d[index]), 220);
      });
    }

    /**
     * The speaker keeps still and the two arcs scale away from it, which is what YouTube's own
     * ytp-svg-volume-animation-* classes do with the transform already on those paths.
     */
    paintVolume() {
      const quiet = this.muted || this.volume === 0;
      const next = quiet ? ICONS.muted : ICONS.volume;

      this.volumeButton.title = quiet ? 'Unmute (m)' : 'Mute (m)';

      if (this.volumeShape !== next) {
        this.volumeShape = next;
        this.volumeButton.replaceChildren(icon(next, { size: 24 }));
      }

      if (quiet) return;

      const [, small, big] = this.volumeButton.querySelectorAll('path');

      // One arc for a whisper, both for anything above a third.
      if (small) small.style.transform = `translate(18px, 12px) scale(${this.volume > 0 ? 1 : 0}) translate(-18px, -12px)`;
      if (big) big.style.transform = `translate(22px, 12px) scale(${this.volume > 0.33 ? 1 : 0}) translate(-22px, -12px)`;
    }

    /** YouTube's bezel: the icon of what just happened, fading out over the picture. */
    flash(path, text) {
      this.bezelIcon.replaceChildren(icon(path, { size: 40 }));

      this.bezel.classList.remove('is-shown');
      void this.bezel.offsetWidth; // Restart the animation when the same key is pressed twice.
      this.bezel.classList.add('is-shown');

      if (text) {
        this.bezelText.textContent = text;
        this.bezelTextWrap.classList.remove('is-shown');
        void this.bezelTextWrap.offsetWidth;
        this.bezelTextWrap.classList.add('is-shown');
      }

      clearTimeout(this.bezelTimer);
      this.bezelTimer = setTimeout(() => {
        this.bezel.classList.remove('is-shown');
        this.bezelTextWrap.classList.remove('is-shown');
      }, 500);
    }

    /** A line that stays long enough to be read, for things the viewer has to act on. */
    notice(message, ms = 4500) {
      this.bezelText.textContent = message;

      this.bezelTextWrap.classList.remove('is-shown');
      void this.bezelTextWrap.offsetWidth;
      this.bezelTextWrap.classList.add('is-shown');

      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => this.bezelTextWrap.classList.remove('is-shown'), ms);
    }

    working(message) {
      this.root.dataset.state = 'working';
      this.status.replaceChildren(el('div', { class: 'ap-status-line', text: message }));
    }

    /**
     * An instance answers the operator, not the viewer. "Set COOKIES_PATH to a Netscape-format
     * cookies file" is the right thing to tell whoever runs the server and useless to someone
     * watching through the public one, so the known failures are said again in terms of what the
     * person looking at the screen can actually do.
     */
    static explain(message) {
      const raw = String(message ?? '');

      if (/signed-in session|cookies file|COOKIES_PATH/i.test(raw)) {
        return {
          title: 'YouTube asked the instance to sign in',
          // Worth saying outright, because the obvious reading is wrong: being signed in here
          // changes nothing. The fetch happens on the server, from its address, and your session
          // never leaves this browser.
          detail: 'The instance fetches from its own address, not from your browser, so your own '
            + 'YouTube login does not apply to it. YouTube does this to servers it does not '
            + 'recognise, often only for a moment - trying again usually works. If the instance '
            + 'is yours, giving it a cookies file settles it for good.',
          retry: true,
        };
      }

      if (/DRM/i.test(raw)) {
        return {
          title: 'This video is DRM protected',
          detail: 'Nothing can be done about that from here - it cannot be fetched at all.',
          retry: false,
        };
      }

      if (/took too long/i.test(raw)) {
        return {
          title: 'The instance took too long',
          detail: 'Resolving a video it has not seen before can be slow. Trying again is usually '
            + 'faster, because the work it already did is kept.',
          retry: true,
        };
      }

      if (/could not be reached|Failed to fetch|NetworkError/i.test(raw)) {
        return {
          title: 'The instance could not be reached',
          detail: 'Check the address under Settings, and that the instance is running.',
          retry: true,
        };
      }

      return { title: 'Argon Play could not start this video', detail: raw, retry: true };
    }

    fail(message) {
      this.root.dataset.state = 'error';
      this.wantPlaying = false;
      this.halt();

      const said = Player.explain(message);

      this.status.replaceChildren(
        el('div', { class: 'ap-status-title', text: said.title }),
        el('div', { class: 'ap-status-line', text: said.detail }),
        el('div', { class: 'ap-status-actions' }, [
          said.retry ? el('button', {
            class: 'ap-action',
            type: 'button',
            text: 'Try again',
            onclick: () => this.onRetry?.(),
          }) : null,
          el('button', {
            class: 'ap-action ap-action-quiet',
            type: 'button',
            text: "Use YouTube's player",
            onclick: () => this.onFallback?.(),
          }),
        ]),
      );
    }

    describeError(error, which) {
      const reasons = {
        1: 'the stream was aborted',
        2: 'the connection to the instance dropped',
        3: `the ${which} could not be decoded`,
        4: `the instance did not serve a playable ${which} stream`,
      };

      return `Playback stopped because ${reasons[error?.code] ?? 'of an unknown media error'}.`;
    }

    // ---------------------------------------------------------------- chapters

    /**
     * YouTube splits the rail into one length per chapter with a gap between them, and each piece
     * fills independently. Rebuilt whenever the chapters or the duration change, because the
     * widths are proportions of a length that is not always known when the page first speaks.
     */
    buildSegments() {
      const end = this.duration();
      const spans = this.spans(end);

      this.segmentNodes = spans.map((span) => {
        const buffered = el('div', { class: 'ap-load-progress' });
        const hover = el('div', { class: 'ap-hover-progress' });
        const played = el('div', { class: 'ap-play-progress' });

        const node = el('div', {
          class: 'ap-progress-list',
          style: { flexGrow: String(Math.max(span.end - span.start, 0.001)) },
        }, [buffered, hover, played]);

        return { ...span, node, buffered, hover, played };
      });

      this.segments.replaceChildren(...this.segmentNodes.map((segment) => segment.node));
      this.root.classList.toggle('has-chapters', this.chapters.length > 1);

      // The old single-bar references still exist for code that does not care about chapters.
      this.buffered = this.segmentNodes[0]?.buffered ?? this.buffered;
      this.played = this.segmentNodes[0]?.played ?? this.played;
      this.hoverFill = this.segmentNodes[0]?.hover ?? this.hoverFill;
    }

    /** Chapter boundaries, or one span covering everything when there are none. */
    spans(end) {
      if (!Number.isFinite(end) || end <= 0) return [{ start: 0, end: 1, title: null }];

      if (this.chapters.length < 2) return [{ start: 0, end, title: null }];

      return this.chapters.map((chapter, index) => ({
        start: chapter.start,
        end: index + 1 < this.chapters.length ? this.chapters[index + 1].start : end,
        title: chapter.title,
      }));
    }

    chapterAt(seconds) {
      if (this.chapters.length === 0) return null;

      let found = null;

      for (const chapter of this.chapters) {
        if (chapter.start <= seconds) found = chapter;
        else break;
      }

      return found;
    }

    /** Fills each piece by how far the playhead has come into it. */
    paintSegments(now, ahead) {
      if (!this.segmentNodes) return;

      for (const segment of this.segmentNodes) {
        const length = segment.end - segment.start;

        if (length <= 0) continue;

        const within = (value) => Math.min(1, Math.max(0, (value - segment.start) / length));

        segment.played.style.transform = `scaleX(${within(now)})`;
        segment.buffered.style.transform = `scaleX(${within(ahead)})`;

        if (this.hoverAt !== undefined) {
          segment.hover.style.transform = `scaleX(${within(this.hoverAt)})`;
        }
      }
    }

    paintChapterName() {
      const chapter = this.chapterAt(this.at());

      if (!this.chapterName) return;

      const title = chapter?.title ?? '';

      this.chapterName.hidden = title === '';
      this.chapterLabel.textContent = title;
      this.chapterName.title = title;
    }

    // ---------------------------------------------------------------- hover preview

    /** The frame, the time and the chapter, following the pointer along the bar. */
    paintPreview(ratio, end) {
      const seconds = ratio * end;
      const box = this.bar.getBoundingClientRect();

      this.preview.style.left = `${ratio * 100}%`;
      this.previewTime.textContent = time(seconds);

      const chapter = this.chapterAt(seconds);

      this.previewChapter.textContent = chapter?.title ?? '';
      this.previewChapter.hidden = !chapter?.title;

      const frame = this.board?.at(seconds);

      if (frame) {
        // Scaled up a little: the sheets are small and a crisp 160px frame looks mean next to
        // YouTube's, which shows the same image at about this size.
        const scale = 1.35;

        Object.assign(this.previewFrame.style, {
          display: 'block',
          width: `${this.board.width * scale}px`,
          height: `${this.board.height * scale}px`,
          backgroundImage: `url("${frame.url}")`,
          backgroundPosition: `${frame.x * scale}px ${frame.y * scale}px`,
          backgroundSize: `${this.board.width * this.board.columns * scale}px auto`,
        });
      } else {
        this.previewFrame.style.display = 'none';
      }

      this.preview.classList.add('is-shown');

      // Keep it inside the player rather than letting it hang off the end.
      const half = this.preview.offsetWidth / 2;
      const left = ratio * box.width;
      const shift = Math.min(Math.max(left, half), box.width - half) - left;

      this.preview.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
    }

    // ---------------------------------------------------------------- settings

    /*
     * YouTube's settings menu is a table, not a list, and it moves: opening a sub-menu measures
     * the next panel, animates the popup to that size, and slides the two panels past each other.
     * Both of those are reproduced here, along with the row shapes - a checkbox row carries a
     * switch on the right, a link row carries its current value and a chevron, and a radio row
     * hides its value cell, indents its label and draws the tick in the gutter.
     */

    /** A row that opens a panel of its own. */
    linkRow(iconSpec, label, value, panel) {
      return el('div', {
        class: 'ap-menuitem',
        role: 'menuitem',
        'aria-haspopup': 'true',
        tabindex: '0',
        onclick: () => this.showPanel(panel, 'forward'),
      }, [
        el('div', { class: 'ap-menuitem-icon' }, [icon(iconSpec, { size: 24 })]),
        el('div', { class: 'ap-menuitem-label', text: label }),
        el('div', { class: 'ap-menuitem-content', text: value }),
      ]);
    }

    /** A row that is a switch. */
    toggleRow(iconSpec, label, on, onChange) {
      const row = el('div', {
        class: 'ap-menuitem',
        role: 'menuitemcheckbox',
        'aria-checked': String(on),
        tabindex: '0',
        onclick: () => {
          const next = row.getAttribute('aria-checked') !== 'true';
          row.setAttribute('aria-checked', String(next));
          onChange(next);
        },
      }, [
        el('div', { class: 'ap-menuitem-icon' }, [icon(iconSpec, { size: 24 })]),
        el('div', { class: 'ap-menuitem-label', text: label }),
        el('div', { class: 'ap-menuitem-content' }, [el('div', { class: 'ap-menuitem-toggle' })]),
      ]);

      return row;
    }

    /** A row in a sub-menu: one of several, one of them ticked. */
    radioRow(label, checked, choose, { hint } = {}) {
      return el('div', {
        class: 'ap-menuitem',
        role: 'menuitemradio',
        'aria-checked': String(checked),
        tabindex: '0',
        onclick: () => {
          choose();
          this.closeSettings();
        },
      }, [
        el('div', { class: 'ap-menuitem-label' }, [
          el('span', { text: label }),
          hint ? el('span', { class: 'ap-menuitem-hint', text: hint }) : null,
        ]),
      ]);
    }

    panelNode(rows, title) {
      const menu = el('div', { class: 'ap-panel-menu', role: 'menu' }, rows);

      if (!title) return el('div', { class: 'ap-panel' }, [menu]);

      const header = el('div', {
        class: 'ap-panel-header',
        onclick: () => this.showPanel('main', 'back'),
      }, [
        el('div', { class: 'ap-panel-back-container' }, [
          el('button', { class: 'ap-panel-back', type: 'button', 'aria-label': 'Back' }),
        ]),
        el('span', { class: 'ap-panel-title', text: title }),
      ]);

      return el('div', { class: 'ap-panel' }, [header, menu]);
    }

    /** Builds one panel by name. */
    panelFor(name) {
      if (name === 'quality') {
        const ladder = globalThis.Argon.ladder(
          this.tracks.video.length > 0 ? this.tracks.video : this.tracks.muxed,
          this.videoTrack,
        );

        return this.panelNode(
          ladder.map((track) => this.radioRow(
            track.label,
            track.url === this.videoTrack?.url,
            () => this.apply(track, this.audioTrack),
            { hint: size(track.bytes) },
          )),
          'Quality',
        );
      }

      if (name === 'speed') {
        return this.panelNode(
          SPEEDS.map((rate) => this.radioRow(
            rate === 1 ? 'Normal' : String(rate),
            this.video.playbackRate === rate,
            () => this.setSpeed(rate),
          )),
          'Playback speed',
        );
      }

      if (name === 'audio') {
        return this.panelNode(
          globalThis.Argon.playable(this.tracks.audio).map((track) => this.radioRow(
            track.label,
            track.url === this.audioTrack?.url,
            () => this.apply(this.videoTrack, track),
            { hint: size(track.bytes) },
          )),
          'Audio',
        );
      }

      if (name === 'chapters') {
        const now = this.at();
        const current = this.chapterAt(now);

        return this.panelNode(
          this.chapters.map((chapter) => this.radioRow(
            chapter.title,
            chapter === current,
            () => this.seek(chapter.start),
            { hint: time(chapter.start) },
          )),
          'Chapters',
        );
      }

      if (name === 'subtitles') {
        const rows = [this.radioRow('Off', this.caption === null, () => this.setCaption(null))];

        for (const track of this.captions) {
          rows.push(this.radioRow(
            track.automatic ? `${track.name} (auto-generated)` : track.name,
            this.caption?.url === track.url,
            () => this.setCaption(track),
          ));
        }

        return this.panelNode(rows, 'Subtitles');
      }

      // ---- the main panel

      const rows = [
        this.toggleRow(ICONS.ambient, 'Ambient mode', this.ambient, (on) => this.setAmbient(on)),
        this.toggleRow(ICONS.autoplay, 'Autoplay', this.autoplay, (on) => { this.autoplay = on; }),
      ];

      if (this.chapters.length > 1) {
        rows.push(this.linkRow(
          ICONS.chapters,
          'Chapters',
          this.chapterAt(this.at())?.title ?? '—',
          'chapters',
        ));
      }

      if (this.captions.length > 0) {
        rows.push(this.linkRow(
          ICONS.subtitles,
          'Subtitles',
          this.caption ? this.caption.name : 'Off',
          'subtitles',
        ));
      }

      rows.push(this.linkRow(
        ICONS.speed,
        'Playback speed',
        this.video.playbackRate === 1 ? 'Normal' : String(this.video.playbackRate),
        'speed',
      ));

      rows.push(this.linkRow(ICONS.quality, 'Quality', this.videoTrack?.label ?? '—', 'quality'));

      if (this.degraded) {
        rows.push(el('div', { class: 'ap-menu-footnote' }, [
          el('span', { text: 'This instance predates the playback endpoint, so streams are muxed as they are sent and cannot seek.' }),
        ]));
      }

      if (this.audioTrack) {
        rows.push(this.linkRow(ICONS.audio, 'Audio', this.audioTrack.label, 'audio'));
      }

      return this.panelNode(rows);
    }

    /**
     * Swaps the open panel for another, animating the popup to the new size while the two slide
     * past each other. The measurement happens off to one side because a panel that is already
     * positioned has the old panel's width.
     */
    showPanel(name, direction) {
      const next = this.panelFor(name);

      next.classList.add('is-measuring');
      this.popup.appendChild(next);

      const width = Math.min(Math.max(next.offsetWidth, 250), Math.round(this.root.clientWidth * 0.7));
      const height = Math.min(next.offsetHeight, Math.round(this.root.clientHeight * 0.7));

      next.classList.remove('is-measuring');
      next.style.width = `${width}px`;

      const current = this.currentPanel;

      this.currentPanel = next;
      this.panel = name;

      if (!current) {
        this.settings.style.width = `${width}px`;
        this.settings.style.height = `${height}px`;
        return;
      }

      current.style.width = `${current.offsetWidth}px`;

      next.classList.add(direction === 'back' ? 'ap-panel-enter-back' : 'ap-panel-enter-forward');
      void next.offsetWidth; // start from the offset position rather than jumping to it

      this.settings.classList.add('is-animating');
      this.settings.style.width = `${width}px`;
      this.settings.style.height = `${height}px`;

      next.classList.remove('ap-panel-enter-back', 'ap-panel-enter-forward');
      current.classList.add(direction === 'back' ? 'ap-panel-leave-back' : 'ap-panel-leave-forward');

      clearTimeout(this.panelTimer);
      clearTimeout(this.noticeTimer);
      this.panelTimer = setTimeout(() => {
        current.remove();
        this.settings.classList.remove('is-animating');
      }, PANEL_MS);
    }

    toggleSettings() {
      if (this.settings.classList.contains('is-open')) {
        this.closeSettings();
        return;
      }

      this.popup.replaceChildren();
      this.currentPanel = null;

      this.settings.classList.add('is-open');
      this.settingsButton.classList.add('is-active');
      this.settingsButton.setAttribute('aria-expanded', 'true');

      this.showPanel('main', 'forward');
      this.wake();
    }

    closeSettings() {
      this.settings.classList.remove('is-open');
      this.settings.classList.remove('is-animating');
      this.settingsButton.classList.remove('is-active');
      this.settingsButton.setAttribute('aria-expanded', 'false');
      this.panel = 'main';
    }

    /** Kept for the places that only want the open panel refreshed in place. */
    buildSettings() {
      if (!this.settings.classList.contains('is-open')) return;

      const name = this.panel ?? 'main';

      this.popup.replaceChildren();
      this.currentPanel = null;
      this.showPanel(name, 'forward');
    }

    // ---------------------------------------------------------------- ambient

    /**
     * The glow YouTube calls ambient mode: the picture, shrunk to a few dozen pixels, blown back
     * up behind the player and blurred until only the colour is left.
     */
    setAmbient(on) {
      this.ambient = on;
      this.root.classList.toggle('has-ambient', on);

      // Keep an open menu honest when this is switched from anywhere but its own row.
      const row = [...this.settings.querySelectorAll('.ap-menuitem[role="menuitemcheckbox"]')]
        .find((node) => node.querySelector('.ap-menuitem-label')?.textContent === 'Ambient mode');

      row?.setAttribute('aria-checked', String(on));

      clearInterval(this.ambientTimer);

      if (!on) return;

      const context = this.ambientCanvas.getContext('2d', { willReadFrequently: false });

      const paint = () => {
        if (this.destroyed || this.video.readyState < 2) return;

        try {
          context.drawImage(this.video, 0, 0, this.ambientCanvas.width, this.ambientCanvas.height);
        } catch {
          // A cross-origin frame taints the canvas but still draws; anything else, give up quietly.
        }
      };

      paint();
      this.ambientTimer = setInterval(paint, AMBIENT_MS);
      this.fitVideo();
    }

    /**
     * With ambient on, the video element is sized to the picture instead of being left to
     * letterbox inside a bigger box: Chrome paints those bars opaque black from inside the video
     * renderer, where no CSS background can reach them, and they would cover the glow exactly
     * where it is supposed to show.
     */
    fitVideo() {
      if (!this.ambient) {
        this.video.style.width = '';
        this.video.style.height = '';
        return;
      }

      const { videoWidth: width, videoHeight: height } = this.video;

      if (!width || !height) return;

      const box = this.root.getBoundingClientRect();

      if (!box.width || !box.height) return;

      const scale = Math.min(box.width / width, box.height / height);

      this.video.style.width = `${Math.round(width * scale)}px`;
      this.video.style.height = `${Math.round(height * scale)}px`;
    }

    // ---------------------------------------------------------------- subtitles

    /**
     * The caption tracks belong to the page, not to the instance: YouTube already listed them
     * under the viewer's own session, signed URLs and all. Asked for WebVTT they drop straight
     * into a <track>, and a blob keeps the element same-origin.
     */
    async setCaption(track) {
      this.caption = track;

      for (const existing of [...this.video.querySelectorAll('track')]) existing.remove();

      if (this.captionUrl) {
        URL.revokeObjectURL(this.captionUrl);
        this.captionUrl = null;
      }

      this.paintCaptionButton();

      if (!track) return;

      try {
        const vtt = await this.fetchCaptions(track);

        if (this.caption?.url !== track.url) return; // switched again while this was in flight

        this.captionUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));

        const node = el('track', {
          kind: 'subtitles',
          srclang: track.lang,
          label: track.name,
          src: this.captionUrl,
          default: '',
        });

        this.video.appendChild(node);

        // Chrome ignores `default` on a track added after the element already has a source.
        node.addEventListener('load', () => {
          if (node.track) node.track.mode = 'showing';
        });

        if (node.track) node.track.mode = 'showing';
      } catch (error) {
        log('captions failed', error);
        this.caption = null;
        this.paintCaptionButton();
        this.flash(ICONS.subtitles, 'Subtitles unavailable');
      }
    }

    /**
     * timedtext answers in whichever format it feels like. `fmt=vtt` is the one we want and is
     * also the one that most often comes back empty, so each format is tried in turn and the
     * result is checked rather than trusted - an empty body makes a track with no cues, which
     * looks exactly like subtitles being broken and reports no error at all.
     */
    async fetchCaptions(track) {
      const attempts = [
        { fmt: 'vtt', parse: (body) => (body.trimStart().startsWith('WEBVTT') ? body : null) },
        { fmt: 'json3', parse: (body) => Player.json3ToVtt(body) },
        { fmt: null, parse: (body) => Player.xmlToVtt(body) },
      ];

      const failures = [];

      for (const attempt of attempts) {
        const url = attempt.fmt ? `${track.url}&fmt=${attempt.fmt}` : track.url;

        try {
          const response = await fetch(url, { credentials: 'same-origin' });

          if (!response.ok) {
            failures.push(`${attempt.fmt ?? 'xml'}: ${response.status}`);
            continue;
          }

          const body = await response.text();
          const vtt = body.trim().length > 0 ? attempt.parse(body) : null;

          if (vtt && /\d\d:\d\d/.test(vtt)) return vtt;

          failures.push(`${attempt.fmt ?? 'xml'}: ${body.trim().length === 0 ? 'empty' : 'unparsable'}`);
        } catch (error) {
          failures.push(`${attempt.fmt ?? 'xml'}: ${error}`);
        }
      }

      throw new Error(`timedtext gave nothing usable (${failures.join(', ')})`);
    }

    static timestamp(seconds) {
      const whole = Math.max(0, seconds);
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const rest = whole % 60;

      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
        + `${rest.toFixed(3).padStart(6, '0')}`;
    }

    /** {"events":[{"tStartMs":0,"dDurationMs":1200,"segs":[{"utf8":"..."}]}]} */
    static json3ToVtt(body) {
      let data;

      try {
        data = JSON.parse(body);
      } catch {
        return null;
      }

      const lines = ['WEBVTT', ''];

      for (const event of data.events ?? []) {
        const text = (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('').trim();

        if (!text || event.tStartMs === undefined) continue;

        const from = event.tStartMs / 1000;
        const to = from + (event.dDurationMs ?? 2000) / 1000;

        lines.push(`${Player.timestamp(from)} --> ${Player.timestamp(to)}`, text, '');
      }

      return lines.length > 2 ? lines.join('\n') : null;
    }

    /**
     * The entities left over after the XML parser has had its turn. Done by hand rather than by
     * assigning innerHTML somewhere: youtube.com requires Trusted Types, and this whole player is
     * built without ever handing the parser a string.
     */
    static unescape(text) {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

      return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
        if (body[0] !== '#') return named[body.toLowerCase()] ?? whole;

        const code = body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);

        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      });
    }

    /** <transcript><text start="0" dur="1.5">...</text></transcript> */
    static xmlToVtt(body) {
      let document_;

      try {
        document_ = new DOMParser().parseFromString(body, 'text/xml');
      } catch {
        return null;
      }

      const nodes = [...document_.querySelectorAll('text')];

      if (nodes.length === 0) return null;

      const lines = ['WEBVTT', ''];

      for (const node of nodes) {
        const from = Number(node.getAttribute('start'));
        const length = Number(node.getAttribute('dur') ?? 2);

        // The payload is HTML-escaped inside XML, so the XML parser leaves one layer behind.
        const text = Player.unescape(node.textContent ?? '').trim();

        if (!Number.isFinite(from) || !text) continue;

        lines.push(`${Player.timestamp(from)} --> ${Player.timestamp(from + length)}`, text, '');
      }

      return lines.length > 2 ? lines.join('\n') : null;
    }

    paintCaptionButton() {
      const on = Boolean(this.caption);

      this.captionButton?.classList.toggle('is-active', on);
      this.captionButton?.setAttribute('aria-pressed', String(on));
      if (this.captionButton) this.captionButton.title = on ? 'Subtitles off (c)' : 'Subtitles (c)';
    }

    /** What boot.js hands over once the page has told it what it holds. */
    describePage({ captions, upNext, duration, chapters, storyboard }) {
      this.captions = captions ?? [];
      this.upNext = upNext ?? null;
      this.chapters = (chapters ?? []).filter((chapter) => Number.isFinite(chapter.start));
      this.board = globalThis.Argon.storyboard(storyboard);

      // A muxed stream has no length of its own, so without this the total counts up as the
      // video downloads and the bar has nothing to measure against.
      if (Number.isFinite(duration) && duration > 0) {
        this.pageDuration = duration;
      }

      this.buildSegments();
      this.paint();

      if (this.captionButton) {
        this.captionButton.style.display = this.captions.length > 0 ? '' : 'none';
      }

      this.buildSettings();
    }

    toggleCaptions() {
      if (this.captions.length === 0) {
        this.flash(ICONS.subtitles, 'No subtitles');
        return;
      }

      if (this.caption) {
        this.setCaption(null);
        return;
      }

      // The viewer's own language first, then whatever a human wrote, then anything at all.
      const language = (navigator.language || 'en').slice(0, 2).toLowerCase();

      const pick = this.captions.find((t) => !t.automatic && t.lang.toLowerCase().startsWith(language))
        ?? this.captions.find((t) => t.lang.toLowerCase().startsWith(language))
        ?? this.captions.find((t) => !t.automatic)
        ?? this.captions[0];

      this.setCaption(pick);
    }

    // ---------------------------------------------------------------- input

    key(event) {
      const typing = event.target.matches?.('input, textarea, [contenteditable="true"]');
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      const actions = {
        ' ': () => this.toggle(),
        k: () => this.toggle(),
        j: () => this.nudge(-10),
        l: () => this.nudge(10),
        ArrowLeft: () => this.nudge(-5),
        ArrowRight: () => this.nudge(5),
        ArrowUp: () => this.setVolume((this.volume ?? 1) + 0.05, { fromUser: true }),
        ArrowDown: () => this.setVolume((this.volume ?? 1) - 0.05, { fromUser: true }),
        m: () => this.toggleMute(),
        f: () => this.toggleFullscreen(),
        i: () => this.togglePip(),
        c: () => this.toggleCaptions(),
        t: () => this.toggleTheater(),
        Home: () => this.seek(0),
        End: () => this.seek(this.duration()),
        '<': () => this.stepSpeed(-1),
        '>': () => this.stepSpeed(1),
      };

      if (/^[0-9]$/.test(event.key)) {
        const end = this.duration();
        if (Number.isFinite(end)) this.seek((Number(event.key) / 10) * end);
      } else if (actions[event.key]) {
        actions[event.key]();
      } else {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.wake();
    }

    stepSpeed(direction) {
      const index = SPEEDS.indexOf(this.video.playbackRate);
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (index < 0 ? 3 : index) + direction))];
      this.setSpeed(next);
    }

    wake() {
      this.root.classList.remove('is-idle');
      clearTimeout(this.idleTimer);

      this.idleTimer = setTimeout(() => {
        if (this.wantPlaying && !this.settings.classList.contains('is-open')) this.sleep();
      }, CHROME_IDLE_MS);
    }

    sleep() {
      if (this.wantPlaying && !this.settings.classList.contains('is-open')) {
        this.root.classList.add('is-idle');
      }
    }

    // ---------------------------------------------------------------- lifecycle

    mount(parent, reference) {
      if (reference) parent.insertBefore(this.root, reference);
      else parent.appendChild(this.root);
    }

    destroy() {
      this.destroyed = true;

      clearInterval(this.ticker);
      clearInterval(this.ambientTimer);
      this.resizer?.disconnect();
      clearTimeout(this.idleTimer);
      clearTimeout(this.bezelTimer);
      clearTimeout(this.panelTimer);

      if (this.captionUrl) URL.revokeObjectURL(this.captionUrl);

      document.removeEventListener('pointerdown', this.dismiss, true);
      document.removeEventListener('keydown', this.escape, true);
      document.removeEventListener('visibilitychange', this.hidden);

      this.internal = true;

      for (const element of [this.video, this.audio]) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }

      this.root.remove();
    }
  }

  globalThis.Argon.Player = Player;
})();
