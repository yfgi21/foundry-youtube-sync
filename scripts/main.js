const MODULE_ID = "foundry-youtube-sync";
const SOCKET = `module.${MODULE_ID}`;
const SETTING_STATE = "playbackState";
const DRIFT_THRESHOLD = 1.15;
const CORRECTION_INTERVAL_MS = 2500;

const DEFAULT_STATE = Object.freeze({
  revision: 0,
  videoId: "",
  sourceUrl: "",
  status: "stopped",
  position: 0,
  serverTime: 0
});

class FoundryYouTubeSync {
  constructor() {
    this.state = { ...DEFAULT_STATE };
    this.player = null;
    this.playerReady = false;
    this.loadedVideoId = "";
    this.panel = null;
    this.playerHost = null;
    this.seekInput = null;
    this.timeLabel = null;
    this.titleLabel = null;
    this.statusLabel = null;
    this.lastCorrectionAt = 0;
    this.applyingState = false;
    this.youtubeApiPromise = null;
    this.uiTimer = null;
    this.gestureListener = null;
    this.lastAutoplayNotice = 0;
  }

  async initialize() {
    this.state = this.normalizeState(game.settings.get(MODULE_ID, SETTING_STATE));
    game.socket.on(SOCKET, (message) => this.onSocket(message));

    Hooks.on("renderPlaylistDirectory", (_app, element) => this.mount(element));
    Hooks.on("globalPlaylistVolumeChanged", () => this.applyVolume());
    Hooks.on("globalMusicVolumeChanged", () => this.applyVolume());
    Hooks.on("updateSetting", (setting) => this.onSettingUpdate(setting));

    // Browser autoplay policies can block the initial playVideo() call until the
    // user interacts with the page. Only use a genuine user gesture to resume a
    // player which is not already playing. Never force a synchronization seek
    // from this handler: canvas pointer events (especially right-click panning)
    // are extremely frequent and a forced seek causes visible YouTube buffering.
    this.gestureListener = (event) => this.handleUserGesture(event);
    document.addEventListener("pointerdown", this.gestureListener, { capture: true });
    document.addEventListener("keydown", this.gestureListener, { capture: true });

    const directory = game.playlists?.directory;
    if (directory?.rendered && directory.element) this.mount(directory.element);

    this.uiTimer = window.setInterval(() => this.tick(), 500);
  }

  handleUserGesture(event) {
    if (this.state.status !== "playing" || !this.playerReady || !this.player || !this.isMainVideoLoaded()) return;

    // Right-click is Foundry's normal canvas-pan interaction. It must never
    // touch YouTube playback when the player is already running.
    if (event?.type === "pointerdown" && Number(event.button) !== 0) return;

    let playerState = null;
    try { playerState = this.player.getPlayerState?.(); } catch (_) {}

    const YT = window.YT;
    if (YT && (
      playerState === YT.PlayerState.PLAYING ||
      playerState === YT.PlayerState.BUFFERING
    )) return;

    // If autoplay was blocked, resume from the common timeline. Seek only when
    // the player is actually out of sync; an ordinary user gesture should not
    // reload/buffer a healthy stream.
    try {
      const expected = this.expectedPosition();
      const current = Number(this.player.getCurrentTime?.());
      if (Number.isFinite(current) && Math.abs(current - expected) > DRIFT_THRESHOLD) {
        this.player.seekTo(expected, true);
      }
      this.player.playVideo?.();
    } catch (error) {
      console.debug(`${MODULE_ID} | Autoplay resume deferred`, error);
    }
  }

  normalizeState(raw) {
    const state = foundry.utils.mergeObject({ ...DEFAULT_STATE }, raw ?? {}, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true
    });
    state.revision = Number.isFinite(Number(state.revision)) ? Number(state.revision) : 0;
    state.position = Math.max(0, Number(state.position) || 0);
    state.serverTime = Number(state.serverTime) || 0;
    if (!["playing", "paused", "stopped"].includes(state.status)) state.status = "stopped";
    state.videoId = String(state.videoId ?? "");
    state.sourceUrl = String(state.sourceUrl ?? "");
    return state;
  }

  serverNow() {
    return Number(game.time?.serverTime) || Date.now();
  }

  expectedPosition(state = this.state) {
    if (!state.videoId) return 0;
    if (state.status !== "playing") return Math.max(0, Number(state.position) || 0);
    const elapsed = Math.max(0, (this.serverNow() - (Number(state.serverTime) || this.serverNow())) / 1000);
    return Math.max(0, (Number(state.position) || 0) + elapsed);
  }

  isAuthorizedSocket(message) {
    if (!message?.userId) return false;
    return Boolean(game.users?.get(message.userId)?.isGM);
  }

  onSocket(message) {
    if (message?.type !== "state" || !this.isAuthorizedSocket(message)) return;
    const next = this.normalizeState(message.state);
    if (next.revision < this.state.revision) return;
    this.state = next;
    this.applyState(next, { force: true });
    this.updateUi();
  }

  onSettingUpdate(setting) {
    const key = setting?.key ?? setting?._source?.key;
    if (key !== `${MODULE_ID}.${SETTING_STATE}`) return;
    const next = this.normalizeState(setting?.value ?? setting?._source?.value);
    if (next.revision < this.state.revision) return;
    this.state = next;
    this.applyState(next, { force: true });
    this.updateUi();
  }

  async commit(patch) {
    if (!game.user?.isGM) {
      ui.notifications.warn(game.i18n.localize("ALPHAYT.GMOnly"));
      return;
    }

    const current = this.normalizeState(this.state);
    const next = this.normalizeState({
      ...current,
      ...patch,
      revision: current.revision + 1,
      serverTime: this.serverNow()
    });

    this.state = next;
    this.applyState(next, { force: true });
    this.updateUi();

    game.socket.emit(SOCKET, {
      type: "state",
      userId: game.user.id,
      state: next
    });

    try {
      await game.settings.set(MODULE_ID, SETTING_STATE, next);
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to persist playback state`, error);
    }
  }

  mount(element) {
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!(root instanceof HTMLElement)) return;

    let panel = root.querySelector(".alpha-ytmusic-panel");
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "alpha-ytmusic-panel";
      panel.dataset.moduleId = MODULE_ID;
      panel.innerHTML = this.panelHtml();

      const insertionPoint = root.querySelector(".global-volume, .playlist-header, header") ?? root.firstElementChild;
      if (insertionPoint?.parentElement === root) insertionPoint.insertAdjacentElement("afterend", panel);
      else root.prepend(panel);
    }

    this.panel = panel;
    this.playerHost = panel.querySelector(".alpha-ytmusic-player-host");

    // PlaylistDirectory is an ApplicationV2 and can rebuild its DOM. If that
    // happened, discard the stale YouTube player bound to the previous iframe.
    if (this.player) {
      let iframe = null;
      try { iframe = this.player.getIframe?.(); } catch (_) {}
      if (!iframe?.isConnected || !panel.contains(iframe)) {
        try { this.player.destroy?.(); } catch (_) {}
        this.player = null;
        this.playerReady = false;
        this.loadedVideoId = "";
      }
    }

    this.seekInput = panel.querySelector("[data-yt-seek]");
    this.timeLabel = panel.querySelector("[data-yt-time]");
    this.titleLabel = panel.querySelector("[data-yt-title]");
    this.statusLabel = panel.querySelector("[data-yt-status]");

    this.bindPanelListeners(panel);
    this.ensurePlayer();
    this.updateUi();
  }

  panelHtml() {
    const gm = Boolean(game.user?.isGM);
    const t = (key) => game.i18n.localize(key);
    return `
      <div class="alpha-ytmusic-header">
        <div class="alpha-ytmusic-title"><i class="fa-brands fa-youtube"></i> <span data-yt-title>${t("ALPHAYT.NoTrack")}</span></div>
        <span class="alpha-ytmusic-status" data-yt-status>${t("ALPHAYT.StatusStopped")}</span>
      </div>
      ${gm ? `
      <div class="alpha-ytmusic-url-row">
        <input type="url" data-yt-url autocomplete="off" spellcheck="false" placeholder="${t("ALPHAYT.UrlPlaceholder")}">
        <button type="button" data-yt-action="load" data-tooltip="${t("ALPHAYT.Load")}"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>
      </div>` : ""}
      <div class="alpha-ytmusic-transport">
        <button type="button" data-yt-action="back" data-tooltip="${t("ALPHAYT.Back")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-backward"></i></button>
        <button type="button" data-yt-action="toggle" data-tooltip="${t("ALPHAYT.Play")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-play"></i></button>
        <button type="button" data-yt-action="forward" data-tooltip="${t("ALPHAYT.Forward")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-forward"></i></button>
        <button type="button" data-yt-action="stop" data-tooltip="${t("ALPHAYT.Stop")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-stop"></i></button>
      </div>
      <div class="alpha-ytmusic-time-row">
        <input type="range" min="0" max="1" step="0.1" value="0" data-yt-seek ${gm ? "" : "disabled"}>
        <span class="alpha-ytmusic-time" data-yt-time>00:00 / 00:00</span>
      </div>
      <div class="alpha-ytmusic-player-wrap">
        <div class="alpha-ytmusic-player-host"></div>
      </div>
    `;
  }

  bindPanelListeners(panel) {
    if (panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";

    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-yt-action]");
      if (!button || !game.user?.isGM) return;
      const action = button.dataset.ytAction;
      if (action === "load") return this.loadFromInput();
      if (!this.state.videoId) return;

      if (action === "toggle") {
        if (this.state.status === "playing") return this.pause();
        return this.play();
      }
      if (action === "back") return this.seek(this.currentAuthoritativePosition() - 10);
      if (action === "forward") return this.seek(this.currentAuthoritativePosition() + 10);
      if (action === "stop") return this.stop();
    });

    const input = panel.querySelector("[data-yt-url]");
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.loadFromInput();
      }
    });

    const seek = panel.querySelector("[data-yt-seek]");
    seek?.addEventListener("change", () => {
      if (!game.user?.isGM) return;
      this.seek(Number(seek.value));
    });
  }

  loadFromInput() {
    const input = this.panel?.querySelector("[data-yt-url]");
    const parsed = this.parseYouTubeUrl(input?.value ?? "");
    if (!parsed) {
      ui.notifications.warn(game.i18n.localize("ALPHAYT.InvalidUrl"));
      return;
    }
    this.commit({
      videoId: parsed.videoId,
      sourceUrl: input.value.trim(),
      status: "playing",
      position: parsed.startSeconds
    });
  }

  parseYouTubeUrl(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
      return { videoId: raw, startSeconds: 0 };
    }

    let url;
    try {
      url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      return null;
    }

    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    let videoId = "";
    if (host === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? "";
      else {
        const parts = url.pathname.split("/").filter(Boolean);
        if (["embed", "shorts", "live"].includes(parts[0])) videoId = parts[1] ?? "";
      }
    }

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const rawTime = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "0";
    return { videoId, startSeconds: this.parseTime(rawTime) };
  }

  parseTime(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));
    const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) return 0;
    return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
  }

  currentAuthoritativePosition() {
    if (this.playerReady && this.isMainVideoLoaded()) {
      const current = Number(this.player.getCurrentTime?.());
      if (Number.isFinite(current)) return current;
    }
    return this.expectedPosition();
  }

  play() {
    const position = this.currentAuthoritativePosition();
    return this.commit({ status: "playing", position });
  }

  pause() {
    const position = this.currentAuthoritativePosition();
    return this.commit({ status: "paused", position });
  }

  stop() {
    return this.commit({ status: "stopped", position: 0 });
  }

  seek(seconds) {
    const duration = this.getDuration();
    let position = Math.max(0, Number(seconds) || 0);
    if (duration > 0) position = Math.min(position, duration);
    return this.commit({ position });
  }

  async loadYouTubeApi() {
    if (window.YT?.Player) return window.YT;
    if (this.youtubeApiPromise) return this.youtubeApiPromise;

    this.youtubeApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = (...args) => {
        try { previous?.(...args); } catch (error) { console.warn(`${MODULE_ID} | Existing YouTube callback failed`, error); }
        if (window.YT?.Player) resolve(window.YT);
        else reject(new Error("YouTube IFrame API loaded without YT.Player"));
      };

      const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (existing) return;

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.referrerPolicy = "strict-origin-when-cross-origin";
      script.onerror = () => reject(new Error("Unable to load YouTube IFrame API"));
      document.head.appendChild(script);
    });

    return this.youtubeApiPromise;
  }

  async ensurePlayer() {
    if (!this.playerHost || !this.state.videoId) return;
    if (this.player && this.playerReady) {
      this.applyState(this.state, { force: true });
      return;
    }

    try {
      const YT = await this.loadYouTubeApi();
      if (!this.playerHost?.isConnected) return;

      this.playerReady = false;
      this.player = new YT.Player(this.playerHost, {
        width: "100%",
        height: "200",
        videoId: this.state.videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: (event) => this.onPlayerReady(event),
          onStateChange: (event) => this.onPlayerStateChange(event),
          onError: (event) => this.onPlayerError(event)
        }
      });
    } catch (error) {
      console.error(`${MODULE_ID} | YouTube player initialization failed`, error);
    }
  }

  onPlayerReady() {
    this.playerReady = true;
    this.loadedVideoId = this.player.getVideoData?.().video_id || this.state.videoId;
    this.applyVolume();
    this.applyState(this.state, { force: true });
    this.updateUi();
  }

  onPlayerStateChange(event) {
    if (!window.YT) return;
    const state = event.data;
    if (state === window.YT.PlayerState.ENDED && game.user?.isGM && this.isMainVideoLoaded()) {
      this.commit({ status: "stopped", position: this.getDuration() || 0 });
      return;
    }

    if (!game.user?.isGM || this.applyingState || !this.isMainVideoLoaded()) return;

    // Keep the official YouTube controls usable by the GM for play/pause.
    // Seeking is intentionally synchronized through the Foundry seek bar,
    // because the IFrame API does not expose a reliable dedicated seek event.
    if (state === window.YT.PlayerState.PAUSED && this.state.status === "playing") {
      this.commit({ position: this.currentAuthoritativePosition(), status: "paused" });
    } else if (state === window.YT.PlayerState.PLAYING && this.state.status === "paused") {
      this.commit({ position: this.currentAuthoritativePosition(), status: "playing" });
    }
  }

  onPlayerError(event) {
    console.warn(`${MODULE_ID} | YouTube player error`, event.data);
    ui.notifications.warn(game.i18n.format("ALPHAYT.PlayerError", { code: event.data }));
  }

  isMainVideoLoaded() {
    if (!this.playerReady || !this.player) return false;
    const videoId = this.player.getVideoData?.().video_id;
    return !videoId || videoId === this.state.videoId;
  }

  async applyState(state = this.state, { force = false } = {}) {
    if (!this.panel || !state.videoId) {
      this.updateUi();
      return;
    }
    if (!this.player || !this.playerReady) {
      this.ensurePlayer();
      return;
    }

    this.applyingState = true;
    try {
      const target = this.expectedPosition(state);
      const videoId = this.player.getVideoData?.().video_id || this.loadedVideoId;
      const changedVideo = videoId !== state.videoId;

      if (changedVideo) {
        if (state.status === "playing") {
          this.player.loadVideoById({ videoId: state.videoId, startSeconds: target });
        } else {
          this.player.cueVideoById({ videoId: state.videoId, startSeconds: target });
        }
        this.loadedVideoId = state.videoId;
      } else if (this.isMainVideoLoaded()) {
        const current = Number(this.player.getCurrentTime?.()) || 0;
        const drift = Math.abs(current - target);
        if (force || drift > DRIFT_THRESHOLD) this.player.seekTo(target, true);

        if (state.status === "playing") this.player.playVideo();
        else if (state.status === "paused") this.player.pauseVideo();
        else this.player.stopVideo();
      }

      this.applyVolume();
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to apply synchronized state`, error);
    } finally {
      window.setTimeout(() => { this.applyingState = false; }, 150);
    }
  }

  applyVolume() {
    if (!this.playerReady || !this.player?.setVolume) return;
    let volume = 1;
    try {
      const setting = game.settings.get("core", "globalPlaylistVolume");
      if (Number.isFinite(Number(setting))) volume = Math.max(0, Math.min(1, Number(setting)));
    } catch (_) {}
    if (game.audio?.globalMute) volume = 0;
    try { this.player.setVolume(Math.round(volume * 100)); } catch (_) {}
  }

  getDuration() {
    if (!this.playerReady || !this.player?.getDuration) return 0;
    const duration = Number(this.player.getDuration());
    return Number.isFinite(duration) ? Math.max(0, duration) : 0;
  }

  tick() {
    this.updateUi();
    this.applyVolume();

    if (!this.playerReady || !this.player || this.state.status !== "playing" || !this.isMainVideoLoaded()) return;
    const now = performance.now();
    if (now - this.lastCorrectionAt < CORRECTION_INTERVAL_MS) return;
    this.lastCorrectionAt = now;

    const expected = this.expectedPosition();
    const current = Number(this.player.getCurrentTime?.()) || 0;
    const drift = Math.abs(current - expected);
    const playerState = this.player.getPlayerState?.();
    const buffering = window.YT && playerState === window.YT.PlayerState.BUFFERING;

    if (!buffering && drift > DRIFT_THRESHOLD) {
      try {
        this.player.seekTo(expected, true);
        this.player.playVideo();
      } catch (error) {
        console.debug(`${MODULE_ID} | Drift correction deferred`, error);
      }
    }
  }

  updateUi() {
    if (!this.panel) return;
    const hasTrack = Boolean(this.state.videoId);
    this.panel.classList.toggle("alpha-ytmusic-empty", !hasTrack);

    const title = this.playerReady && this.isMainVideoLoaded()
      ? (this.player.getVideoData?.().title || this.state.videoId)
      : (hasTrack ? this.state.videoId : game.i18n.localize("ALPHAYT.NoTrack"));
    if (this.titleLabel) this.titleLabel.textContent = title;

    const statusKey = this.state.status === "playing"
      ? "ALPHAYT.StatusPlaying"
      : this.state.status === "paused"
        ? "ALPHAYT.StatusPaused"
        : "ALPHAYT.StatusStopped";
    if (this.statusLabel) this.statusLabel.textContent = game.i18n.localize(statusKey);

    const toggle = this.panel.querySelector('[data-yt-action="toggle"]');
    if (toggle) {
      const playing = this.state.status === "playing";
      toggle.innerHTML = `<i class="fa-solid ${playing ? "fa-pause" : "fa-play"}"></i>`;
      toggle.dataset.tooltip = game.i18n.localize(playing ? "ALPHAYT.Pause" : "ALPHAYT.Play");
    }

    const duration = this.getDuration();
    let current = this.expectedPosition();
    if (this.playerReady && this.isMainVideoLoaded()) {
      const playerCurrent = Number(this.player.getCurrentTime?.());
      if (Number.isFinite(playerCurrent)) current = playerCurrent;
    }

    if (duration > 0) current = Math.min(current, duration);
    if (this.seekInput) {
      this.seekInput.max = String(Math.max(1, duration || current || 1));
      if (document.activeElement !== this.seekInput) this.seekInput.value = String(Math.max(0, current));
    }
    if (this.timeLabel) this.timeLabel.textContent = `${this.formatTime(current)} / ${this.formatTime(duration)}`;
  }

  formatTime(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
}

const controller = new FoundryYouTubeSync();

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_STATE, {
    name: "YouTube playback state",
    scope: "world",
    config: false,
    type: Object,
    default: { ...DEFAULT_STATE }
  });
});

Hooks.once("ready", async () => {
  await controller.initialize();
  game.modules.get(MODULE_ID).api = {
    getState: () => foundry.utils.deepClone(controller.state),
    playUrl: (url) => {
      const parsed = controller.parseYouTubeUrl(url);
      if (!parsed) throw new Error("Invalid YouTube URL");
      return controller.commit({ videoId: parsed.videoId, sourceUrl: url, status: "playing", position: parsed.startSeconds });
    },
    play: () => controller.play(),
    pause: () => controller.pause(),
    stop: () => controller.stop(),
    seek: (seconds) => controller.seek(seconds)
  };
});
