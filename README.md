# Foundry YouTube Sync

A lightweight Foundry VTT v14 module that embeds YouTube playback directly into the **Playlists** sidebar and keeps GM-controlled playback synchronized across connected clients.

<p align="center"><img src="docs/images/playlists-integration.jpg" alt="Foundry YouTube Sync integrated into the Playlists sidebar" width="300"></p>

## Features

- Paste a YouTube URL directly into the Foundry Playlists sidebar.
- GM controls for play, pause, stop, seek, skip back 10 seconds, and skip forward 10 seconds.
- Shared playback timeline synchronized through Foundry sockets and `game.time.serverTime`.
- Automatic drift correction between connected clients.
- Late-join synchronization: a player joining an already-playing session receives the live GM state and cues the video at the correct server-time position before attempting playback.
- Playback state persistence across refreshes and reconnects.
- Foundry's native **Music / Playlists** volume setting controls the local YouTube player volume.
- Players can see the current video and timeline, while global playback controls remain GM-only.
- Supports `youtube.com/watch`, `youtu.be`, Shorts, Live, Embed, and `t=` / `start=` timestamps.
- System-agnostic: no Pathfinder 2e dependency is required.

## YouTube limitations

This module uses the official YouTube IFrame Player API. It does not block, replace, or bypass YouTube advertisements. Ads may differ between clients, so perfect synchronization cannot be guaranteed while an advertisement is playing. The module automatically corrects playback drift when normal video playback resumes.

YouTube error `101` / `150` means that the video owner has disabled playback in embedded players. This is a YouTube restriction and cannot be bypassed by the module. Age-restricted or otherwise non-embeddable videos may also fail in the embedded player.

The official embedded YouTube player must remain available in the Playlists panel; the module does not extract or redistribute YouTube audio.

## Manual installation

Copy the `foundry-youtube-sync` folder into:

```text
FoundryVTT/Data/modules/
```

Then enable **Foundry YouTube Sync** in your world.

## Macro API

```js
await game.modules.get("foundry-youtube-sync").api.playUrl("https://youtu.be/VIDEO_ID");
await game.modules.get("foundry-youtube-sync").api.pause();
await game.modules.get("foundry-youtube-sync").api.play();
await game.modules.get("foundry-youtube-sync").api.seek(90);
await game.modules.get("foundry-youtube-sync").api.stop();
```

## Compatibility

- Foundry VTT v14
- System-agnostic

## Changelog

### 0.1.4

- Reworked late-join initialization to wait for the active GM's live state.
- Late joiners now cue the current video at the calculated server-time position before attempting playback.
- Added YouTube `widget_referrer` context to the embedded player.
- Tightened player-state detection so an empty player is never treated as the synchronized video.
- Improved handling and documentation of YouTube embedding errors `101` / `150`.

### 0.1.3

- Improved player initialization and late-join recovery.
- Fixed unsafe video-data access during player initialization.

### 0.1.2

- Added live GM state handshake for late-joining players.
- Added local recovery attempts for transient YouTube initialization errors.

### 0.1.1

- Fixed micro-buffering when right-clicking or panning the Foundry canvas.
- User-gesture autoplay recovery no longer forces a YouTube seek on every pointer interaction.
- Right-click canvas interactions never alter healthy YouTube playback.

### 0.1.0

- Initial synchronized YouTube playback implementation.
- Native Playlists sidebar integration.
- GM-authoritative playback controls.
- Shared timeline, reconnect recovery, drift correction, and Foundry Music volume integration.
