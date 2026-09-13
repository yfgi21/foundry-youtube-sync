const MODULE_ID = "foundry-youtube-sync";
const SOCKET = `module.${MODULE_ID}`;
const SETTING_STATE = "playbackState";
const DRIFT = 1.15;
const CORRECTION_MS = 2500;
const JOIN_DELAYS = [400, 1200, 2600];
const DEFAULT = { revision: 0, videoId: "", sourceUrl: "", status: "stopped", position: 0, serverTime: 0 };

class FoundryYouTubeSync {
  constructor() {
    this.state = { ...DEFAULT };
    this.player = null;
    this.playerReady = false;
    this.loadedVideoId = "";
    this.panel = null;
    this.host = null;
    this.seekInput = null;
    this.timeLabel = null;
    this.titleLabel = null;
    this.statusLabel = null;
    this.apiPromise = null;
    this.tickTimer = null;
    this.correctionAt = 0;
    this.applying = false;
    this.joinWaiting = !game.user?.isGM;
    this.joinRequestTimers = [];
    this.joinSyncTimers = [];
    this.pendingJoinPlayback = false;
    this.playerErrorShown = false;
  }

  async initialize() {
    this.state = this.normalize(game.settings.get(MODULE_ID, SETTING_STATE));
    game.socket.on(SOCKET, m => this.onSocket(m));
    Hooks.on("renderPlaylistDirectory", (_app, el) => this.mount(el));
    Hooks.on("globalPlaylistVolumeChanged", () => this.applyVolume());
    Hooks.on("globalMusicVolumeChanged", () => this.applyVolume());
    Hooks.on("updateSetting", s => this.onSetting(s));
    document.addEventListener("pointerdown", e => this.userGesture(e), { capture: true });
    document.addEventListener("keydown", e => this.userGesture(e), { capture: true });
    const d = game.playlists?.directory;
    if (d?.rendered && d.element) this.mount(d.element);
    this.tickTimer = window.setInterval(() => this.tick(), 500);
    if (this.joinWaiting) this.requestLiveState();
  }

  normalize(raw) {
    const s = foundry.utils.mergeObject({ ...DEFAULT }, raw ?? {}, { inplace: false, overwrite: true, insertKeys: true, insertValues: true });
    s.revision = Number.isFinite(Number(s.revision)) ? Number(s.revision) : 0;
    s.position = Math.max(0, Number(s.position) || 0);
    s.serverTime = Number(s.serverTime) || 0;
    s.videoId = String(s.videoId ?? "");
    s.sourceUrl = String(s.sourceUrl ?? "");
    if (!["playing", "paused", "stopped"].includes(s.status)) s.status = "stopped";
    return s;
  }

  now() { return Number(game.time?.serverTime) || Date.now(); }
  expected(s = this.state) {
    if (!s.videoId || s.status !== "playing") return Math.max(0, Number(s.position) || 0);
    return Math.max(0, (Number(s.position) || 0) + Math.max(0, this.now() - (Number(s.serverTime) || this.now())) / 1000);
  }
  isGM(id = game.user?.id) { return Boolean(game.users?.get(id)?.isGM); }
  primaryGM() { return Array.from(game.users ?? []).filter(u => u.active && u.isGM).sort((a,b) => String(a.id).localeCompare(String(b.id)))[0]?.id === game.user?.id; }
  clear(list) { for (const t of list ?? []) window.clearTimeout(t); list.length = 0; }

  requestLiveState() {
    if (game.user?.isGM) return;
    this.clear(this.joinRequestTimers);
    const send = () => { if (this.joinWaiting) game.socket.emit(SOCKET, { type: "request-state", userId: game.user.id }); };
    send();
    for (const delay of [900, 2200]) this.joinRequestTimers.push(window.setTimeout(send, delay));
    window.setTimeout(() => { if (this.joinWaiting) { this.joinWaiting = false; this.applyState(this.state); } }, 3500);
  }

  onSocket(m) {
    if (m?.type === "request-state") {
      if (!game.user?.isGM || !this.primaryGM()) return;
      if (!game.users?.get(m.userId)?.active) return;
      game.socket.emit(SOCKET, { type: "state", userId: game.user.id, targetUserId: m.userId, reason: "join-sync", state: this.state });
      return;
    }
    if (m?.type !== "state" || !this.isGM(m.userId)) return;
    if (m.targetUserId && m.targetUserId !== game.user?.id) return;
    const next = this.normalize(m.state);
    if (next.revision < this.state.revision) return;
    const join = m.reason === "join-sync" && m.targetUserId === game.user?.id;
    if (join) { this.joinWaiting = false; this.clear(this.joinRequestTimers); }
    this.state = next;
    this.applyState(next, { force: join, joinSync: join });
    this.updateUi();
  }

  onSetting(s) {
    if ((s?.key ?? s?._source?.key) !== `${MODULE_ID}.${SETTING_STATE}`) return;
    const next = this.normalize(s?.value ?? s?._source?.value);
    if (next.revision < this.state.revision) return;
    this.state = next;
    if (!this.joinWaiting) this.applyState(next);
    this.updateUi();
  }

  async commit(patch) {
    if (!game.user?.isGM) return ui.notifications.warn(game.i18n.localize("ALPHAYT.GMOnly"));
    const next = this.normalize({ ...this.state, ...patch, revision: this.state.revision + 1, serverTime: this.now() });
    this.state = next;
    await this.applyState(next, { force: true });
    this.updateUi();
    game.socket.emit(SOCKET, { type: "state", userId: game.user.id, state: next });
    try { await game.settings.set(MODULE_ID, SETTING_STATE, next); } catch (e) { console.error(`${MODULE_ID} | state persistence failed`, e); }
  }

  mount(element) {
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!(root instanceof HTMLElement)) return;
    let panel = root.querySelector(`.${MODULE_ID}-panel`);
    if (!panel) {
      panel = document.createElement("section");
      panel.className = `${MODULE_ID}-panel alpha-ytmusic-panel`;
      panel.innerHTML = this.html();
      const point = root.querySelector(".global-volume, .playlist-header, header") ?? root.firstElementChild;
      if (point?.parentElement === root) point.insertAdjacentElement("afterend", panel); else root.prepend(panel);
    }
    this.panel = panel;
    const newHost = panel.querySelector(".alpha-ytmusic-player-host");
    if (this.player && this.host !== newHost) {
      try { this.player.destroy?.(); } catch (_) {}
      this.player = null; this.playerReady = false; this.loadedVideoId = "";
    }
    this.host = newHost;
    this.seekInput = panel.querySelector("[data-yt-seek]");
    this.timeLabel = panel.querySelector("[data-yt-time]");
    this.titleLabel = panel.querySelector("[data-yt-title]");
    this.statusLabel = panel.querySelector("[data-yt-status]");
    if (panel.dataset.bound !== "1") {
      panel.dataset.bound = "1";
      panel.addEventListener("click", e => this.panelClick(e));
      panel.querySelector("[data-yt-url]")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); this.loadFromInput(); } });
      panel.querySelector("[data-yt-seek]")?.addEventListener("change", e => { if (game.user?.isGM) this.seek(Number(e.target.value)); });
    }
    this.ensurePlayer(); this.updateUi();
  }

  html() {
    const gm = Boolean(game.user?.isGM), t = k => game.i18n.localize(k);
    return `<div class="alpha-ytmusic-header"><div class="alpha-ytmusic-title"><i class="fa-brands fa-youtube"></i> <span data-yt-title>${t("ALPHAYT.NoTrack")}</span></div><span class="alpha-ytmusic-status" data-yt-status>${t("ALPHAYT.StatusStopped")}</span></div>
      ${gm ? `<div class="alpha-ytmusic-url-row"><input type="url" data-yt-url autocomplete="off" spellcheck="false" placeholder="${t("ALPHAYT.UrlPlaceholder")}"><button type="button" data-yt-action="load"><i class="fa-solid fa-arrow-right-to-bracket"></i></button></div>` : ""}
      <div class="alpha-ytmusic-transport"><button type="button" data-yt-action="back" ${gm ? "" : "disabled"}><i class="fa-solid fa-backward"></i></button><button type="button" data-yt-action="toggle" ${gm ? "" : "disabled"}><i class="fa-solid fa-play"></i></button><button type="button" data-yt-action="forward" ${gm ? "" : "disabled"}><i class="fa-solid fa-forward"></i></button><button type="button" data-yt-action="stop" ${gm ? "" : "disabled"}><i class="fa-solid fa-stop"></i></button></div>
      <div class="alpha-ytmusic-time-row"><input type="range" min="0" max="1" step="0.1" value="0" data-yt-seek ${gm ? "" : "disabled"}><span class="alpha-ytmusic-time" data-yt-time>00:00 / 00:00</span></div>
      <div class="alpha-ytmusic-player-wrap"><div class="alpha-ytmusic-player-host"></div></div>`;
  }

  panelClick(e) {
    const b = e.target.closest("[data-yt-action]");
    if (!b || !game.user?.isGM) return;
    const a = b.dataset.ytAction;
    if (a === "load") return this.loadFromInput();
    if (!this.state.videoId) return;
    if (a === "toggle") return this.state.status === "playing" ? this.pause() : this.play();
    if (a === "back") return this.seek(this.authoritative() - 10);
    if (a === "forward") return this.seek(this.authoritative() + 10);
    if (a === "stop") return this.stop();
  }

  loadFromInput() {
    const input = this.panel?.querySelector("[data-yt-url]"), p = this.parseUrl(input?.value);
    if (!p) return ui.notifications.warn(game.i18n.localize("ALPHAYT.InvalidUrl"));
    this.commit({ videoId: p.videoId, sourceUrl: String(input.value).trim(), status: "playing", position: p.startSeconds });
  }

  parseUrl(value) {
    const raw = String(value ?? "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return { videoId: raw, startSeconds: 0 };
    let u; try { u = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { return null; }
    const h = u.hostname.replace(/^www\./, "").toLowerCase(); let id = "";
    if (h === "youtu.be") id = u.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (h.endsWith("youtube.com")) { if (u.pathname === "/watch") id = u.searchParams.get("v") ?? ""; else { const p = u.pathname.split("/").filter(Boolean); if (["embed", "shorts", "live"].includes(p[0])) id = p[1] ?? ""; } }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { videoId: id, startSeconds: this.parseTime(u.searchParams.get("t") ?? u.searchParams.get("start") ?? "0") };
  }

  parseTime(v) { const s = String(v ?? "0").toLowerCase().trim(); if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s); const m = s.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); return m ? (Number(m[1])||0)*3600+(Number(m[2])||0)*60+(Number(m[3])||0) : 0; }

  async loadApi() {
    if (window.YT?.Player) return window.YT;
    if (this.apiPromise) return this.apiPromise;
    this.apiPromise = new Promise((resolve, reject) => {
      const old = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = (...args) => { try { old?.(...args); } catch (_) {} if (window.YT?.Player) resolve(window.YT); else reject(new Error("YT.Player unavailable")); };
      if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) return;
      const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; s.async = true; s.referrerPolicy = "strict-origin-when-cross-origin"; s.onerror = () => reject(new Error("YouTube API failed")); document.head.appendChild(s);
    });
    return this.apiPromise;
  }

  async ensurePlayer() {
    if (!this.host || this.player || (this.joinWaiting && !game.user?.isGM)) return;
    try {
      const YT = await this.loadApi(); if (!this.host?.isConnected) return;
      this.player = new YT.Player(this.host, { width: "100%", height: "200", playerVars: { autoplay: 0, controls: 1, enablejsapi: 1, origin: window.location.origin, widget_referrer: window.location.href, playsinline: 1, rel: 0 }, events: { onReady: () => this.ready(), onStateChange: e => this.stateChange(e), onError: e => this.error(e) } });
    } catch (e) { console.error(`${MODULE_ID} | player initialization failed`, e); }
  }

  ready() { this.playerReady = true; this.loadedVideoId = ""; this.applyVolume(); if (!this.joinWaiting) this.applyState(this.state); this.updateUi(); }

  stateChange(e) {
    const YT = window.YT; if (!YT) return;
    if (e.data === YT.PlayerState.CUED && this.pendingJoinPlayback) { this.pendingJoinPlayback = false; if (this.state.status === "playing") window.setTimeout(() => this.player?.playVideo?.(), 0); return; }
    if (e.data === YT.PlayerState.ENDED && game.user?.isGM && this.loadedMatches()) return this.commit({ status: "stopped", position: this.duration() });
    if (!game.user?.isGM || this.applying || !this.loadedMatches()) return;
    if (e.data === YT.PlayerState.PAUSED && this.state.status === "playing") this.commit({ status: "paused", position: this.authoritative() });
    else if (e.data === YT.PlayerState.PLAYING && this.state.status === "paused") this.commit({ status: "playing", position: this.authoritative() });
  }

  error(e) {
    const code = Number(e?.data); console.warn(`${MODULE_ID} | YouTube player error`, code);
    if ((code === 101 || code === 150) && !this.playerErrorShown) { this.playerErrorShown = true; ui.notifications.warn(game.i18n.format("ALPHAYT.PlayerError", { code })); }
  }

  loadedMatches() { if (!this.playerReady || !this.player || !this.state.videoId) return false; const id = this.player.getVideoData?.()?.video_id || this.loadedVideoId; return Boolean(id) && id === this.state.videoId; }
  authoritative() { if (this.loadedMatches()) { const t = Number(this.player.getCurrentTime?.()); if (Number.isFinite(t)) return t; } return this.expected(); }

  async applyState(state = this.state, { force = false, joinSync = false } = {}) {
    if (this.joinWaiting && !joinSync && !game.user?.isGM) return;
    if (!this.playerReady || !this.player || !state.videoId) return;
    this.applying = true;
    try {
      const target = this.expected(state), currentId = this.player.getVideoData?.()?.video_id || this.loadedVideoId, changed = currentId !== state.videoId;
      this.playerErrorShown = false;
      if (changed) {
        if (joinSync && !game.user?.isGM && state.status === "playing") { this.pendingJoinPlayback = true; this.player.cueVideoById({ videoId: state.videoId, startSeconds: target }); }
        else if (state.status === "playing") this.player.loadVideoById({ videoId: state.videoId, startSeconds: target });
        else this.player.cueVideoById({ videoId: state.videoId, startSeconds: target });
        this.loadedVideoId = state.videoId;
      } else if (this.loadedMatches()) {
        const current = Number(this.player.getCurrentTime?.()) || 0;
        if (force || Math.abs(current - target) > DRIFT) this.player.seekTo(target, true);
        if (state.status === "playing") this.player.playVideo?.(); else if (state.status === "paused") this.player.pauseVideo?.(); else this.player.stopVideo?.();
      }
      this.applyVolume(); if (joinSync) this.scheduleJoinSync(state.videoId, state.revision);
    } catch (e) { console.warn(`${MODULE_ID} | applyState failed`, e); }
    finally { window.setTimeout(() => { this.applying = false; }, 120); }
  }

  scheduleJoinSync(id, revision) { this.clear(this.joinSyncTimers); for (const delay of JOIN_DELAYS) this.joinSyncTimers.push(window.setTimeout(() => { if (this.state.videoId === id && this.state.revision >= revision) this.applyState(this.state); }, delay)); }
  userGesture(e) { if (e?.type === "pointerdown" && e.button !== 0) return; if (!this.playerReady || !this.player || this.state.status !== "playing" || !this.loadedMatches()) return; const ps = this.player.getPlayerState?.(), YT = window.YT; if (YT && (ps === YT.PlayerState.PLAYING || ps === YT.PlayerState.BUFFERING)) return; try { this.player.playVideo?.(); } catch (_) {} }
  applyVolume() { if (!this.playerReady || !this.player?.setVolume) return; let v = 1; try { v = Math.max(0, Math.min(1, Number(game.settings.get("core", "globalPlaylistVolume")))); } catch (_) {} if (game.audio?.globalMute) v = 0; try { this.player.setVolume(Math.round(v * 100)); } catch (_) {} }
  play() { return this.commit({ status: "playing", position: this.authoritative() }); }
  pause() { return this.commit({ status: "paused", position: this.authoritative() }); }
  stop() { return this.commit({ status: "stopped", position: 0 }); }
  seek(s) { const d = this.duration(); let p = Math.max(0, Number(s) || 0); if (d) p = Math.min(p, d); return this.commit({ position: p }); }
  duration() { const d = Number(this.player?.getDuration?.()); return Number.isFinite(d) ? Math.max(0, d) : 0; }

  tick() { this.updateUi(); this.applyVolume(); if (!this.playerReady || !this.loadedMatches() || this.state.status !== "playing") return; const now = performance.now(); if (now - this.correctionAt < CORRECTION_MS) return; this.correctionAt = now; const expected = this.expected(), current = Number(this.player.getCurrentTime?.()) || 0; if (Math.abs(current - expected) > DRIFT) { try { this.player.seekTo(expected, true); this.player.playVideo?.(); } catch (_) {} } }

  updateUi() {
    if (!this.panel) return;
    const has = Boolean(this.state.videoId), title = this.loadedMatches() ? (this.player.getVideoData?.()?.title || this.state.videoId) : (has ? this.state.videoId : game.i18n.localize("ALPHAYT.NoTrack"));
    this.panel.classList.toggle("alpha-ytmusic-empty", !has);
    if (this.titleLabel) this.titleLabel.textContent = title;
    const key = this.state.status === "playing" ? "ALPHAYT.StatusPlaying" : this.state.status === "paused" ? "ALPHAYT.StatusPaused" : "ALPHAYT.StatusStopped";
    if (this.statusLabel) this.statusLabel.textContent = game.i18n.localize(key);
    const d = this.duration(), current = this.loadedMatches() ? Number(this.player.getCurrentTime?.()) || 0 : this.expected();
    if (this.seekInput) { this.seekInput.max = String(Math.max(1, d || current || 1)); if (document.activeElement !== this.seekInput) this.seekInput.value = String(Math.max(0, current)); }
    if (this.timeLabel) this.timeLabel.textContent = `${this.time(current)} / ${this.time(d)}`;
    const toggle = this.panel.querySelector('[data-yt-action="toggle"]'); if (toggle) toggle.innerHTML = `<i class="fa-solid ${this.state.status === "playing" ? "fa-pause" : "fa-play"}"></i>`;
  }
  time(v) { const n = Math.max(0, Math.floor(Number(v) || 0)), h = Math.floor(n/3600), m = Math.floor((n%3600)/60), s = n%60; return h ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; }
}

const controller = new FoundryYouTubeSync();
Hooks.once("init", () => game.settings.register(MODULE_ID, SETTING_STATE, { name: "YouTube playback state", scope: "world", config: false, type: Object, default: { ...DEFAULT } }));
Hooks.once("ready", async () => {
  await controller.initialize();
  game.modules.get(MODULE_ID).api = {
    getState: () => foundry.utils.deepClone(controller.state),
    playUrl: url => { const p = controller.parseUrl(url); if (!p) throw new Error("Invalid YouTube URL"); return controller.commit({ videoId: p.videoId, sourceUrl: url, status: "playing", position: p.startSeconds }); },
    play: () => controller.play(), pause: () => controller.pause(), stop: () => controller.stop(), seek: s => controller.seek(s)
  };
});
