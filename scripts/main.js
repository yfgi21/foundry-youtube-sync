const MODULE_ID = "foundry-youtube-sync";
const SOCKET = `module.${MODULE_ID}`;
const SETTING_STATE = "playbackState";
const DRIFT_THRESHOLD = 1.15;
const CORRECTION_INTERVAL_MS = 2500;
const JOIN_SYNC_DELAYS_MS = [350, 1200, 2600];
const RECOVERABLE_PLAYER_ERRORS = new Set([101, 150]);
const MAX_PLAYER_RECOVERY_ATTEMPTS = 2;

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
    this.joinStateResolved = Boolean(game.user?.isGM);
    this.joinStateRequestTimers = [];
    this.joinSyncTimers = [];
    this.recoveryTimer = null;
    this.recoveryKey = "";
    this.recoveryAttempts = 0;
  }

  async initialize() {
    this.state = this.normalizeState(game.settings.get(MODULE_ID, SETTING_STATE));
    game.socket.on(SOCKET, (message) => this.onSocket(message));

    Hooks.on("renderPlaylistDirectory", (_app, element) => this.mount(element));
    Hooks.on("globalPlaylistVolumeChanged", () => this.applyVolume());
    Hooks.on("globalMusicVolumeChanged", () => this.applyVolume());
    Hooks.on("updateSetting", (setting) => this.onSettingUpdate(setting));

    this.gestureListener = (event) => this.handleUserGesture(event);
    document.addEventListener("pointerdown", this.gestureListener, { capture: true });
    document.addEventListener("keydown", this.gestureListener, { capture: true });

    const directory = game.playlists?.directory;
    if (directory?.rendered && directory.element) this.mount(directory.element);

    this.uiTimer = window.setInterval(() => this.tick(), 500);
    if (!game.user?.isGM) this.requestLiveState();
  }

  requestLiveState() {
    if (game.user?.isGM) return;
    this.clearJoinStateRequests();
    const send = () => {
      if (this.joinStateResolved || !game.socket) return;
      game.socket.emit(SOCKET, { type: "request-state", userId: game.user.id });
    };
    send();
    for (const delay of [900, 2200]) this.joinStateRequestTimers.push(window.setTimeout(send, delay));
  }

  clearJoinStateRequests() {
    for (const timer of this.joinStateRequestTimers) window.clearTimeout(timer);
    this.joinStateRequestTimers = [];
  }

  isPrimaryActiveGM() {
    const activeGMs = Array.from(game.users ?? [])
      .filter((user) => user.active && user.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return activeGMs[0]?.id === game.user?.id;
  }

  handleUserGesture(event) {
    if (this.state.status !== "playing" || !this.playerReady || !this.player || !this.isMainVideoLoaded()) return;
    if (event?.type === "pointerdown" && Number(event.button) !== 0) return;

    let playerState = null;
    try { playerState = this.player.getPlayerState?.(); } catch (_) {}
    const YT = window.YT;
    if (YT && (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING)) return;

    try {
      const expected = this.expectedPosition();
      const current = Number(this.player.getCurrentTime?.());
      if (Number.isFinite(current) && Math.abs(current - expected) > DRIFT_THRESHOLD) this.player.seekTo(expected, true);
      this.player.playVideo?.();
    } catch (error) {
      console.debug(`${MODULE_ID} | Autoplay resume deferred`, error);
    }
  }

  normalizeState(raw) {
    const state = foundry.utils.mergeObject({ ...DEFAULT_STATE }, raw ?? {}, {
      inplace: false, insertKeys: true, insertValues: true, overwrite: true
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
    if (message?.type === "request-state") {
      if (!game.user?.isGM || !this.isPrimaryActiveGM()) return;
      const requester = game.users?.get(message.userId);
      if (!requester?.active) return;
      game.socket.emit(SOCKET, {
        type: "state", userId: game.user.id, targetUserId: message.userId,
        reason: "join-sync", state: this.state
      });
      return;
    }
    if (message?.type !== "state" || !this.isAuthorizedSocket(message)) return;
    if (message.targetUserId && message.targetUserId !== game.user?.id) return;
    const next = this.normalizeState(message.state);
    if (next.revision < this.state.revision) return;
    const joinSync = message.reason === "join-sync" && message.targetUserId === game.user?.id;
    if (joinSync) {
      this.joinStateResolved = true;
      this.clearJoinStateRequests();
    }
    this.state = next;
    this.applyState(next, { force: true, joinSync });
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
    const next = this.normalizeState({ ...current, ...patch, revision: current.revision + 1, serverTime: this.serverNow() });
    this.state = next;
    this.applyState(next, { force: true });
    this.updateUi();
    game.socket.emit(SOCKET, { type: "state", userId: game.user.id, state: next });
    try { await game.settings.set(MODULE_ID, SETTING_STATE, next); }
    catch (error) { console.error(`${MODULE_ID} | Failed to persist playback state`, error); }
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
    if (this.player) {
      let iframe = null;
      try { iframe = this.player.getIframe?.(); } catch (_) {}
      if (!iframe?.isConnected || !panel.contains(iframe)) {
        try { this.player.destroy?.(); } catch (_) {}
        this.player = null;
        this.playerReady = false;
        this.loadedVideoId = "";
        this.clearJoinSynchronization();
        this.resetPlayerRecovery();
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
      <div class="alpha-ytmusic-header"><div class="alpha-ytmusic-title"><i class="fa-brands fa-youtube"></i> <span data-yt-title>${t("ALPHAYT.NoTrack")}</span></div><span class="alpha-ytmusic-status" data-yt-status>${t("ALPHAYT.StatusStopped")}</span></div>
      ${gm ? `<div class="alpha-ytmusic-url-row"><input type="url" data-yt-url autocomplete="off" spellcheck="false" placeholder="${t("ALPHAYT.UrlPlaceholder")}"><button type="button" data-yt-action="load" data-tooltip="${t("ALPHAYT.Load")}"><i class="fa-solid fa-arrow-right-to-bracket"></i></button></div>` : ""}
      <div class="alpha-ytmusic-transport"><button type="button" data-yt-action="back" data-tooltip="${t("ALPHAYT.Back")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-backward"></i></button><button type="button" data-yt-action="toggle" data-tooltip="${t("ALPHAYT.Play")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-play"></i></button><button type="button" data-yt-action="forward" data-tooltip="${t("ALPHAYT.Forward")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-forward"></i></button><button type="button" data-yt-action="stop" data-tooltip="${t("ALPHAYT.Stop")}" ${gm ? "" : "disabled"}><i class="fa-solid fa-stop"></i></button></div>
      <div class="alpha-ytmusic-time-row"><input type="range" min="0" max="1" step="0.1" value="0" data-yt-seek ${gm ? "" : "disabled"}><span class="alpha-ytmusic-time" data-yt-time>00:00 / 00:00</span></div>
      <div class="alpha-ytmusic-player-wrap"><div class="alpha-ytmusic-player-host"></div></div>`;
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
      if (action === "toggle") return this.state.status === "playing" ? this.pause() : this.play();
      if (action === "back") return this.seek(this.currentAuthoritativePosition() - 10);
      if (action === "forward") return this.seek(this.currentAuthoritativePosition() + 10);
      if (action === "stop") return this.stop();
    });
    const input = panel.querySelector("[data-yt-url]");
    input?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); this.loadFromInput(); } });
    const seek = panel.querySelector("[data-yt-seek]");
    seek?.addEventListener("change", () => { if (game.user?.isGM) this.seek(Number(seek.value)); });
  }

  loadFromInput() {
    const input = this.panel?.querySelector("[data-yt-url]");
    const parsed = this.parseYouTubeUrl(input?.value ?? "");
    if (!parsed) { ui.notifications.warn(game.i18n.localize("ALPHAYT.InvalidUrl")); return; }
    this.commit({ videoId: parsed.videoId, sourceUrl: input.value.trim(), status: "playing", position: parsed.startSeconds });
  }

  parseYouTubeUrl(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return { videoId: raw, startSeconds: 0 };
    let url;
    try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { return null; }
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
    const startRaw = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "0";
    return { videoId, startSeconds: this.parseTimestamp(startRaw) };
  }

  parseTimestamp(value) {
    const raw = String(value ?? "0").trim().toLowerCase();
    if (/^\d+$/.test(raw)) return Number(raw);
    const match = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!match) return 0;
    return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
  }

  async loadYouTubeApi() {
    if (window.YT?.Player) return window.YT;
    if (this.youtubeApiPromise) return this.youtubeApiPromise;
    this.youtubeApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = (...args) => {
        try { previous?.(...args); } catch (error) { console.warn(`${MODULE_ID} | Existing YouTube callback failed`, error); }
        if (window.YT?.Player) resolve(window.YT); else reject(new Error("YouTube IFrame API loaded without YT.Player"));
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
    if (this.player && this.playerReady) { this.applyState(this.state, { force: true }); return; }
    try {
      const YT = await this.loadYouTubeApi();
      if (!this.playerHost?.isConnected) return;
      this.playerReady = false;
      this.player = new YT.Player(this.playerHost, {
        width: "100%", height: "200",
        playerVars: { autoplay: 0, controls: 1, enablejsapi: 1, origin: window.location.origin, playsinline: 1, rel: 0 },
        events: { onReady: (event) => this.onPlayerReady(event), onStateChange: (event) => this.onPlayerStateChange(event), onError: (event) => this.onPlayerError(event) }
      });
    } catch (error) { console.error(`${MODULE_ID} | YouTube player initialization failed`, error); }
  }

  onPlayerReady() {
    this.playerReady = true;
    this.loadedVideoId = ((this.player.getVideoData?.())?.video_id) || "";
    this.applyVolume();
    this.applyState(this.state, { force: false, joinSync: !game.user?.isGM });
    if (!game.user?.isGM) this.scheduleJoinSynchronization(this.state.videoId, this.state.revision);
    this.updateUi();
  }

  onPlayerStateChange(event) {
    if (!window.YT) return;
    const state = event.data;
    if (state === window.YT.PlayerState.ENDED && game.user?.isGM && this.isMainVideoLoaded()) { this.commit({ status: "stopped", position: this.getDuration() || 0 }); return; }
    if (state === window.YT.PlayerState.PLAYING && this.isMainVideoLoaded()) this.resetPlayerRecovery(this.state.videoId);
    if (!game.user?.isGM || this.applyingState || !this.isMainVideoLoaded()) return;
    if (state === window.YT.PlayerState.PAUSED && this.state.status === "playing") this.commit({ position: this.currentAuthoritativePosition(), status: "paused" });
    else if (state === window.YT.PlayerState.PLAYING && this.state.status === "paused") this.commit({ position: this.currentAuthoritativePosition(), status: "playing" });
  }

  onPlayerError(event) {
    const code = Number(event.data);
    console.warn(`${MODULE_ID} | YouTube player error`, code);
    if (RECOVERABLE_PLAYER_ERRORS.has(code) && this.schedulePlayerRecovery(code)) return;
    ui.notifications.warn(game.i18n.format("ALPHAYT.PlayerError", { code }));
  }

  resetPlayerRecovery(videoId = "") {
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryKey = videoId ? `${videoId}:${this.state.revision}` : "";
    this.recoveryAttempts = 0;
  }

  schedulePlayerRecovery(code) {
    if (!this.playerReady || !this.player || !this.state.videoId) return false;
    const key = `${this.state.videoId}:${this.state.revision}`;
    if (this.recoveryKey !== key) {
      if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null; this.recoveryKey = key; this.recoveryAttempts = 0;
    }
    if (this.recoveryAttempts >= MAX_PLAYER_RECOVERY_ATTEMPTS) return false;
    this.recoveryAttempts += 1;
    const attempt = this.recoveryAttempts;
    const delay = attempt === 1 ? 350 : 1100;
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => { this.recoveryTimer = null; this.recoverCurrentStateLocally({ reload: attempt > 1, errorCode: code }); }, delay);
    return true;
  }

  recoverCurrentStateLocally({ reload = false, errorCode = null } = {}) {
    if (!this.playerReady || !this.player || !this.state.videoId) return;
    const videoId = this.state.videoId;
    const target = this.expectedPosition();
    const status = this.state.status;
    this.applyingState = true;
    try {
      const activeVideo = ((this.player.getVideoData?.())?.video_id) || this.loadedVideoId;
      const playerState = this.player.getPlayerState?.();
      const buffering = window.YT && playerState === window.YT.PlayerState.BUFFERING;
      if (reload || activeVideo !== videoId) {
        if (status === "playing") this.player.loadVideoById({ videoId, startSeconds: target });
        else this.player.cueVideoById({ videoId, startSeconds: target });
        this.loadedVideoId = videoId;
      } else if (!buffering) {
        const current = Number(this.player.getCurrentTime?.());
        if (!Number.isFinite(current) || Math.abs(current - target) > DRIFT_THRESHOLD) this.player.seekTo(target, true);
        if (status === "playing") this.player.playVideo?.();
        else if (status === "paused") this.player.pauseVideo?.();
        else this.player.stopVideo?.();
      }
      this.applyVolume();
      if (errorCode != null) console.debug(`${MODULE_ID} | Local recovery after player error ${errorCode}, attempt ${this.recoveryAttempts}`);
    } catch (error) { console.debug(`${MODULE_ID} | Local player recovery deferred`, error); }
    finally { window.setTimeout(() => { this.applyingState = false; }, 200); }
  }

  clearJoinSynchronization() { for (const timer of this.joinSyncTimers) window.clearTimeout(timer); this.joinSyncTimers = []; }

  scheduleJoinSynchronization(videoId = this.state.videoId, revision = this.state.revision) {
    this.clearJoinSynchronization();
    if (!videoId) return;
    for (const delay of JOIN_SYNC_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        if (this.state.videoId !== videoId || this.state.revision < revision) return;
        this.recoverCurrentStateLocally();
      }, delay);
      this.joinSyncTimers.push(timer);
    }
  }

  isMainVideoLoaded() {
    if (!this.playerReady || !this.player) return false;
    let videoId = "";
    try { videoId = ((this.player.getVideoData?.())?.video_id) || this.loadedVideoId || ""; } catch (_) { videoId = this.loadedVideoId || ""; }
    return !videoId || videoId === this.state.videoId;
  }

  async applyState(state = this.state, { force = false, joinSync = false } = {}) {
    if (!this.panel || !state.videoId) { this.updateUi(); return; }
    if (!this.player || !this.playerReady) { this.ensurePlayer(); return; }
    this.applyingState = true;
    try {
      const target = this.expectedPosition(state);
      const videoId = ((this.player.getVideoData?.())?.video_id) || this.loadedVideoId;
      const changedVideo = videoId !== state.videoId;
      if (changedVideo) {
        if (state.status === "playing") this.player.loadVideoById({ videoId: state.videoId, startSeconds: target });
        else this.player.cueVideoById({ videoId: state.videoId, startSeconds: target });
        this.loadedVideoId = state.videoId;
      } else if (force || joinSync) {
        const current = Number(this.player.getCurrentTime?.());
        if (!Number.isFinite(current) || Math.abs(current - target) > DRIFT_THRESHOLD) this.player.seekTo(target, true);
        if (state.status === "playing") this.player.playVideo?.();
        else if (state.status === "paused") this.player.pauseVideo?.();
        else this.player.stopVideo?.();
      }
      this.applyVolume();
    } catch (error) { console.debug(`${MODULE_ID} | applyState deferred`, error); }
    finally { window.setTimeout(() => { this.applyingState = false; }, 150); }
  }

  currentAuthoritativePosition() { return this.expectedPosition(this.state); }
  getDuration() { return Number(this.player?.getDuration?.()) || 0; }

  play() { return this.commit({ status: "playing", position: this.currentAuthoritativePosition() }); }
  pause() { return this.commit({ status: "paused", position: this.currentAuthoritativePosition() }); }
  stop() { return this.commit({ status: "stopped", position: this.currentAuthoritativePosition() }); }
  seek(position) { return this.commit({ position: Math.max(0, Number(position) || 0), status: this.state.status }); }

  applyVolume() {
    if (!this.playerReady || !this.player) return;
    try {
      const raw = Number(game.settings.get("core", "globalPlaylistVolume"));
      const volume = Math.round(Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 1)) * 100);
      this.player.setVolume?.(volume);
      if (volume <= 0) this.player.mute?.(); else this.player.unMute?.();
    } catch (_) {}
  }

  tick() {
    if (!this.panel) return;
    if (this.state.status === "playing" && this.playerReady && this.player && this.isMainVideoLoaded()) {
      const now = Date.now();
      if (now - this.lastCorrectionAt >= CORRECTION_INTERVAL_MS) {
        this.lastCorrectionAt = now;
        const expected = this.expectedPosition();
        const current = Number(this.player.getCurrentTime?.());
        if (Number.isFinite(current) && Math.abs(current - expected) > DRIFT_THRESHOLD) {
          try { this.player.seekTo(expected, true); } catch (_) {}
        }
      }
    }
    this.updateUi();
  }

  updateUi() {
    if (!this.panel) return;
    const duration = this.getDuration();
    const current = this.playerReady && this.player && this.isMainVideoLoaded() ? Number(this.player.getCurrentTime?.()) || this.expectedPosition() : this.expectedPosition();
    if (this.seekInput) {
      this.seekInput.max = String(Math.max(1, duration || current || 1));
      this.seekInput.value = String(Math.min(Math.max(0, current), Number(this.seekInput.max)));
    }
    if (this.timeLabel) this.timeLabel.textContent = `${this.formatTime(current)} / ${this.formatTime(duration)}`;
    if (this.titleLabel) this.titleLabel.textContent = this.playerReady && this.isMainVideoLoaded() ? (((this.player.getVideoData?.())?.title) || this.state.videoId) : (this.state.videoId || game.i18n.localize("ALPHAYT.NoTrack"));
    if (this.statusLabel) this.statusLabel.textContent = game.i18n.localize(`ALPHAYT.Status${this.state.status.charAt(0).toUpperCase()}${this.state.status.slice(1)}`);
  }

  formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60); const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_STATE, { name: "Playback State", scope: "world", config: false, type: Object, default: { ...DEFAULT_STATE } });
});

Hooks.once("ready", async () => {
  const app = new FoundryYouTubeSync();
  game.modules.get(MODULE_ID).api = {
    playUrl: (url) => { const parsed = app.parseYouTubeUrl(url); if (!parsed) return false; return app.commit({ videoId: parsed.videoId, sourceUrl: String(url).trim(), status: "playing", position: parsed.startSeconds }); },
    play: () => app.play(), pause: () => app.pause(), stop: () => app.stop(), seek: (seconds) => app.seek(seconds), getState: () => ({ ...app.state })
  };
  await app.initialize();
});
