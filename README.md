# Foundry YouTube Sync

A lightweight Foundry VTT v14 module that embeds YouTube playback directly into the **Playlists** sidebar and keeps GM-controlled playback synchronized across connected clients.

<p align="center">
  <img src="docs/images/playlists-integration.jpg" alt="Foundry YouTube Sync integrated into the Playlists sidebar" width="300">
</p>

## Features

- Paste a YouTube URL directly into the Foundry Playlists sidebar.
- GM controls for play, pause, stop, seek, skip back 10 seconds, and skip forward 10 seconds.
- Shared playback timeline synchronized through Foundry sockets and `game.time.serverTime`.
- Automatic drift correction between connected clients.
- Playback state persistence across refreshes and reconnects.
- Foundry's native **Music / Playlists** volume setting controls the local YouTube player volume.
- Players can see the current video and timeline, while global playback controls remain GM-only.
- Supports `youtube.com/watch`, `youtu.be`, Shorts, Live, Embed, and `t=` / `start=` timestamps.
- System-agnostic: no Pathfinder 2e dependency is required.

## YouTube limitations

This module uses the official YouTube IFrame Player API. It does not block, replace, or bypass YouTube advertisements. Ads may differ between clients, so perfect synchronization cannot be guaranteed while an advertisement is playing. The module automatically corrects playback drift when normal video playback resumes.

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

### 0.1.2

- Added a live GM state handshake for players joining while music is already playing.
- Late joiners now load directly at the authoritative server-time position without restarting playback for connected users.
- Added local-only catch-up passes after player initialization to correct startup drift.
- Added targeted recovery for transient YouTube player errors 101/150 during late-join initialization.
- Recovery never broadcasts a new playback state and therefore does not interrupt the GM or other players.

### 0.1.1

- Fixed micro-buffering when right-clicking or panning the Foundry canvas.
- User-gesture autoplay recovery no longer forces a YouTube seek on every pointer interaction.
- Right-click canvas interactions never alter healthy YouTube playback.

### 0.1.0

- Initial synchronized YouTube playback implementation.
- Native Playlists sidebar integration.
- GM-authoritative playback controls.
- Shared timeline, reconnect recovery, drift correction, and Foundry Music volume integration.
