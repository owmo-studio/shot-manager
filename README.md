# owmo-shot-manager

MacOS electron desktop application for reviewing source footage (SD Cards, folders, etc.), adding shot metadata, and ingesting them into my NAS source library.

## Development

Requires Node.js 22.12+ (a supported LTS release is recommended) and npm.

```sh
npm install
npm run dev
```

Opens an Electron window with a React/Tailwind interface and a separate local Fastify backend. The footer checks the backend connection. Use **+** to choose a mounted card or ordinary video folder. Recognized Sony structures show a camera icon and sample embedded original-file metadata for their source name. Every video's metadata is inspected independently of folder names; external XML sidecars are not required or read.

Adding a source starts a read-only recursive scan for common video extensions; hidden entries and symlinks are skipped. Each original video is one shot. Camera thumbnails, sidecars, and proxies are not assembled into associated-media bundles. Legacy Sony `SUB` folders in recognized layouts and files explicitly declaring an embedded Sony proxy codec are excluded. Generic videos are not excluded merely for a `SUB` directory or `S03` filename. Sources scan sequentially and results are cached in memory. Refresh and **×** controls appear on hover or keyboard focus. A rescan stages new results, re-extracts metadata, then commits additions, removals, and updates together; changed files invalidate cached preview state. Failed/incomplete rescans keep the old list. Status polling does not repeatedly probe every video.

Source removal is disabled while its scan is queued or running, and the backend rejects removal during those states. Removal becomes available after completion, failure, or interruption.

Scan transitions are pushed from the backend through Electron to the interface immediately, with progress updates coalesced to about 100ms. Waiting sources show **Queued...**; only the active source shows **Scanning...**, a spinner, and blue styling. Revision numbers prevent delayed request responses from overwriting newer scan events. Five-second polling remains for source availability, backend health, and recovery of current state.

For a newly added source, each clip appears after its metadata inspection and custom-thumbnail cache lookup finish. Processed clips are immediately available for inspection and thumbnail changes while remaining clips continue scanning. Grid additions and the source counter share batched progress updates. New cards enter with a brief 180 ms fade and slight upward motion, disabled when reduced motion is preferred.

During a queued or active rescan, existing clips remain visible, greyed out, and non-editable until reconciliation completes. Additions and removals are committed together at completion; other sources remain unaffected. Unavailable sources retain their red error state.

Refresh is disabled for unavailable sources or while a scan is queued or running. The backend revalidates the source before starting a refresh and rejects concurrent refreshes. Failed or interrupted sources can be refreshed after reconnecting. A detected replacement source identity is treated as a new source rather than merging old-card clips.

Clicking **×** opens a **Cancel / Proceed** confirmation. Proceed removes the source and its clips and metadata from the current workspace; files on disk are never deleted. Cancel or Escape leaves the workspace unchanged.

Source-action errors, including rejected individual file drops, appear in a dismissible popup rather than remaining in the Sources list. Use **Dismiss** or Escape to close it. Repeated background refresh failures notify once until monitoring recovers.

The combined shot grid groups by recording date and defaults to newest first. Its opposing-arrows button reverses the order. Source rows toggle multi-source filters; no active filters means all sources. Capture-specific embedded dates retain their offsets; generic container creation and filesystem modification times are marked uncertain rather than silently treated as recording time. Missing timezones are not replaced with the computer's timezone. FFprobe has an eight-second timeout; unreadable/unsupported candidates retain unknown fields and warnings where possible. This is discovery, not integrity verification.

Sony FX30 and ZV-E10 II metadata works from card roots, copied camera folders, or standalone originals in arbitrary folders. A bounded MP4/MOV reader extracts embedded XML and Apple Log sample-entry declarations without reading the video payload. Source structure is used only for source presentation and legacy-proxy exclusion; no sibling folder outside the selected root is accessed.

Every default preview is a cached first frame extracted from the original video on demand by a sequential FFmpeg queue. Camera proxies and thumbnails are never used. Images fit within 480×270 pixels. Each extraction has a 12-second timeout; failures retain the placeholder without affecting scan/edit eligibility. **Preparing thumbnail…** indicates queued generation; completion is pushed to the interface.

Generated and manually captured previews are cached under Electron's user-data directory in `cache/thumbnails/`, outside the source folder and repository, with a 30-day expiry. Keys include the input path, file identity, size, modification time, source-root identity, and preview settings. Cached previews are application data, separate from source videos; there is no associated-media list or indicator. Cache files are written atomically; source media is never modified and no temporary video copy is created. Concurrent requests for a clip share one generation task. Removed or refreshed source jobs cancel their old thumbnail tasks. FFmpeg receives local input paths and writes image bytes to its output stream, never to the card. If the cache is unwritable, a successfully generated image can still be displayed in memory. Per-source clip counts update as scanning progresses. Selection, metadata editing, and ingestion are still future work.

Click anywhere on a clip card to inspect it; clicking it again deselects it. The right panel remains visible with the same blank, muted layout when no clip is selected. Playback uses the original only, with seeking and an unsupported-codec message rather than automatic transcoding. Rescans/unavailable sources pause preview. Source/proxy generation workflows are deferred; there is no Proxy toggle or associated-media badge/list.

The inspector has **Context** (organizational placeholders) and **File info** tabs. File Info leads with **Device, Codec, Color space, Resolution, and Frame rate**, including bit depth/chroma, orientation/display dimensions, and a single fps value. Duration follows Frame rate with seconds and non-drop-frame HH:MM:SS:FF; filename/path, size, and date continue in the same list. Timing details, color range, and metadata provenance remain in diagnostics rather than summary sublabels. Unknowns remain unknown; color evidence and conflicts are retained. Sony embedded XML identifies capture settings; native iPhone/Blackmagic tags identify device/software; Apple `logs` declarations identify Apple Log even when FFprobe omits the transfer function. Large or unsupported timing tables leave timing mode unknown. Below the combined information list is a collapsible **Embedded metadata** XML/JSON/text blob with copy support. Inspected selection is separate from future ingestion selection. Original video bytes stream through the restricted `shot-media://` protocol and authenticated range-capable backend routes.

The inspector defaults to a minimum width of **560px**. Drag its left edge to enlarge it; the width is retained while switching clips or reopening the panel within the session. The focused divider supports arrow keys (Shift for larger steps), Home/End, and double-click to reset. Resizing leaves room for the source list and clip grid; the application window has a minimum width of 1100px.

The image button at the top of the inspector captures the current original-video frame as a custom JPEG (up to 480×270), replacing any previous capture. It is an action, without toggle/unset behavior. Captured frames take priority over generated first frames and survive restarts while cached, with the same 30-day expiry. Cache keys use source-root and original-file identity, not session shot IDs. Failed saves preserve the previous preview and show an error. Source files are unchanged.

At backend startup, cached thumbnails and abandoned cache temporary files aged **30 days or more** are removed. Age is based on the file's last write time; using a cached image does not extend its expiry. Cleanup touches only recognized cache filenames, skips directories and symlinks, and never touches source media. Missing cache folders are harmless; cleanup failures are logged without blocking startup. The expiry default is centralized in `server/thumbnails.ts`; exposing it in the configuration panel is deferred.

Sources last only for the current backend session. Previous `sources.json` files are no longer read or written. Selected paths are rechecked about every five seconds: missing or inaccessible roots remain in the list as unavailable, with a popup once per outage. Restoring the path clears the unavailable state; a later outage can notify again. Renamed or moved folders can be removed and added at their new location. Changed root identity or sampled metadata creates a fresh source ID. This is live detection, not a guarantee of physical card identity; ingestion will need stronger source validation. Camera models reflect the metadata sample, not an assertion that every shot uses the same camera. No shot-specific configuration is reused between cards.

Use **×** beside a source to remove it from the list without deleting or changing any files. Disconnecting or renaming a source stops any active scan but retains discovered shots and already-loaded thumbnails in the grid. Those shots show a red unavailable state and are flagged non-editable by the backend; future editing and ingestion must enforce source availability. Scans are not automatically repeated on reconnection. Removing a source explicitly clears its shots; replacement source identities also discard old results. Sources and shots remain session-only. The central **+** opens the same picker as **+ Add Source**. Folders or mounted cards can also be dragged from Finder onto the main workspace, including after sources have been added. Individual file drops are rejected. The native picker belongs to the desktop shell; source registration, discovery, and metadata inspection belong to the backend.

`npm run build` checks TypeScript and builds into `out/`. `npm start` opens that build; it does not create an installable application.

## Structure

- `desktop/`: Electron lifecycle and restricted preload bridge.
- `client/`: React interface, styled with Tailwind via Vite.
- `server/`: Fastify service in a supervised Electron utility process.
- `server/discovery.ts`: Recursive original-video discovery and normalized file inspection.
- `server/embedded.ts`: Bounded MP4/MOV embedded XML, log declarations, and frame timing reads.
- `server/videoMetadata.ts`: First-class file metadata normalization, evidence, and unknown/conflict handling.
- `server/scanner.ts`: Background scan lifecycle, cancellation, cached results, and controlled thumbnail reads.
- `server/thumbnails.ts`: Sequential frame extraction and local thumbnail cache.
- `server/media.ts`: Read-only video streaming with byte-range support.
- `shared/`: Frontend/backend types.

The backend listens on a random loopback port with a per-launch token. The frontend requests status through the preload bridge; it has no direct Node.js or filesystem access. Closing the last window or using Cmd+Q quits the app and stops the backend. Frontend edits reload automatically; restart development after changing backend code.

Ingestion and durable recovery features are future work. Develop against isolated dummy folders; reading an explicitly selected source is read-only. Real NAS access requires explicit configuration and authorization.
