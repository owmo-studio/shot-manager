# owmo-shot-manager

MacOS electron desktop application for reviewing source footage (SD Cards, folders, etc.), adding shot metadata, and ingesting them into my NAS source library.

## Development

Requires Node.js 22.12+ (a supported LTS release is recommended) and npm.

```sh
npm install
npm run dev
```

Opens an Electron window with a React/Tailwind interface and a separate local Fastify backend. The footer checks the backend connection. Use **+ Add Source** to choose the root of a mounted card or an ordinary video folder. The backend recognizes Sony's `PRIVATE/M4ROOT/CLIP` structure and samples up to eight XML sidecars (at most 1 MiB each) for camera models, independently of video filenames. Unrecognized structures use the generic video-folder adapter.

Adding a source starts a read-only background scan. Sony discovery lists originals in `CLIP` and matches optional `M01.XML`, `S03.MP4`, and `T01.JPG` companions without counting proxies as extra shots. Generic folders are searched recursively for common video extensions; hidden entries and symlinks are skipped. Sources are scanned sequentially and cached in memory. Each source has a refresh icon beside **×**, shown on hover or keyboard focus, with larger 28px controls. During refresh, existing clips remain visible while fresh results are collected separately. Only after successful completion are additions and removals applied together for that source; entries with the same shot ID are retained. Other sources and list order stay unchanged. Failed, incomplete, or interrupted refreshes keep the previous clips. Metadata reconciliation rules will be defined later. Status polling does not repeatedly probe every video.

Source removal is disabled while its scan is queued or running, and the backend rejects removal during those states. Removal becomes available after completion, failure, or interruption.

Scan transitions are pushed from the backend through Electron to the interface immediately, with progress updates coalesced to about 100ms. Waiting sources show **Queued...**; only the active source shows **Scanning...**, a spinner, and blue styling. Revision numbers prevent delayed request responses from overwriting newer scan events. Five-second polling remains for source availability, backend health, and recovery of current state.

Clips from a queued or scanning source remain visible but are greyed out and flagged non-editable by the backend. Other sources remain unaffected. The normal appearance and edit eligibility return when scanning finishes, unless the source is unavailable, which retains its red error state.

Refresh is disabled for unavailable sources or while a scan is queued or running. The backend revalidates the source before starting a refresh and rejects concurrent refreshes. Failed or interrupted sources can be refreshed after reconnecting. A detected replacement source identity is treated as a new source rather than merging old-card clips.

Clicking **×** opens a **Cancel / Proceed** confirmation. Proceed removes the source and its clips and metadata from the current workspace; files on disk are never deleted. Cancel or Escape leaves the workspace unchanged.

Source-action errors, including rejected individual file drops, appear in a dismissible popup rather than remaining in the Sources list. Use **Dismiss** or Escape to close it. Repeated background refresh failures notify once until monitoring recovers.

The combined shot grid groups by recording date and orders oldest first. Sony XML timestamps retain their recorded offsets; embedded creation timestamps are the next choice. If neither is available, file modification time is shown explicitly as a fallback. FFprobe reads original-file metadata with an eight-second timeout. An unreadable, unsupported, or damaged video candidate remains visible with a metadata warning where possible; it is not declared verified or ready for ingestion. Unreadable files or subfolders are reported while independent work continues. Failed or interrupted scans retain the clips already discovered.

Sony FX30 and ZV-E10 II sources can be added at the card root, `PRIVATE`, `M4ROOT`, or a copied/renamed folder containing the `CLIP` directory. Detection and scanning share the same layout resolver. Selecting `M4ROOT/CLIP` directly reads its originals and XML, but does not access sibling folders outside the selected source; choose `M4ROOT` to include `SUB` proxies and `THMBNL` previews. Ordinary video folders still use generic discovery.

Original video alone is sufficient: XML, proxies, and thumbnails are all optional. Existing camera JPEG thumbnails load on demand and take priority. When a camera image is missing, invalid, oversized, or unreadable, a separate sequential background queue uses FFmpeg to extract one frame, trying the proxy first and the original as fallback. Images fit within 480×270 pixels. Each extraction has a 12-second timeout; a failure retains the placeholder without affecting scanning or editing eligibility. The interface displays **Preparing thumbnail…** while queued and receives a live update when the image is ready.

Camera thumbnails and generated previews are cached under Electron's user-data directory in `cache/thumbnails/`, outside the source folder and repository, with the same 30-day expiry. Keys include the input path, file identity, size, modification time, source-root identity, and preview settings. Camera thumbnails are preview inputs, excluded from the inspector's Media list and the grid's associated-files indicator; proxies and sidecars still count. Cache files are written atomically; source media is never modified and no temporary video copy is created. Concurrent requests for a clip share one generation task. Removed or refreshed source jobs cancel their old thumbnail tasks. FFmpeg receives local input paths and writes image bytes to its output stream, never to the card. If the cache is unwritable, a successfully loaded image can still be displayed in memory. Per-source clip counts update as scanning progresses. Selection, metadata editing, and ingestion are still future work.

Click a clip thumbnail to open the wider right-hand inspector and highlight the inspected clip in the grid. Its small video player supports seeking and defaults to the proxy when one is detected. The **Proxy / High Quality** switch always stays in place; switching preserves the current position. Without a proxy, the switch is greyed out with **High Quality** selected and the player uses the original. A failed proxy preview automatically tries the original once; unsupported codecs or missing files show a playback message without transcoding. Preview is paused while the source is scanning or unavailable, and the inspector closes when its clip is removed.

The inspector has two tabs: **Metadata**, containing disabled identity/project/tags/notes placeholders, and **File info**, containing source details with full system paths. A collapsible **Media (N)** section lists related assets with titles, paths, and sizes. Video metadata is grouped into container/video/audio information with readable field labels, units, codec names, and interpreted frame rates alongside original fractions. Original keys remain available in label tooltips; Camera XML is shown unchanged. These controls do not save or apply metadata yet. The inspected highlight does not select a clip for ingestion. Video bytes are streamed through a restricted `shot-media://` protocol to authenticated backend routes using clip IDs and byte ranges; direct filesystem access and the backend token are not exposed to the interface.

The inspector defaults to a minimum width of **560px**. Drag its left edge to enlarge it; the width is retained while switching clips or reopening the panel within the session. The focused divider supports arrow keys (Shift for larger steps), Home/End, and double-click to reset. Resizing leaves room for the source list and clip grid; the application window has a minimum width of 1100px.

The image button beside the inspector's close button captures the current displayed preview frame as a custom JPEG (up to 480×270). It is active while a custom thumbnail is assigned; pressing it again deletes that custom cache file and reloads the linked camera image, or a placeholder if none exists. Clearing does not trigger automatic frame generation for that clip while its source remains registered. Custom thumbnails take priority over linked camera images, survive application restarts while cached, and use the same 30-day expiry. The cache key uses source-root and original-file identity rather than session-only shot IDs. Saving errors leave the previous thumbnail intact and display an error in the inspector. Captures use the currently displayed proxy or original without modifying source files.

At backend startup, cached thumbnails and abandoned cache temporary files aged **30 days or more** are removed. Age is based on the file's last write time; using a cached image does not extend its expiry. Cleanup touches only recognized cache filenames, skips directories and symlinks, and never touches source media. Missing cache folders are harmless; cleanup failures are logged without blocking startup. The expiry default is centralized in `server/thumbnails.ts`; exposing it in the configuration panel is deferred.

Sources last only for the current backend session. Previous `sources.json` files are no longer read or written. Selected paths are rechecked about every five seconds: missing or inaccessible roots remain in the list as unavailable, with a popup once per outage. Restoring the path clears the unavailable state; a later outage can notify again. Renamed or moved folders can be removed and added at their new location. Changed root identity or sampled metadata creates a fresh source ID. This is live detection, not a guarantee of physical card identity; ingestion will need stronger source validation. Camera models reflect the metadata sample, not an assertion that every shot uses the same camera. No shot-specific configuration is reused between cards.

Use **×** beside a source to remove it from the list without deleting or changing any files. Disconnecting or renaming a source stops any active scan but retains discovered shots and already-loaded thumbnails in the grid. Those shots show a red unavailable state and are flagged non-editable by the backend; future editing and ingestion must enforce source availability. Scans are not automatically repeated on reconnection. Removing a source explicitly clears its shots; replacement source identities also discard old results. Sources and shots remain session-only. The central **+** opens the same picker as **+ Add Source**. Folders or mounted cards can also be dragged from Finder onto the main workspace, including after sources have been added. Individual file drops are rejected. The native picker belongs to the desktop shell; source registration, discovery, and metadata inspection belong to the backend.

`npm run build` checks TypeScript and builds into `out/`. `npm start` opens that build; it does not create an installable application.

## Structure

- `desktop/`: Electron lifecycle and restricted preload bridge.
- `client/`: React interface, styled with Tailwind via Vite.
- `server/`: Fastify service in a supervised Electron utility process.
- `server/discovery.ts`: Sony/generic discovery and optional media metadata.
- `server/scanner.ts`: Background scan lifecycle, cancellation, cached results, and controlled thumbnail reads.
- `server/thumbnails.ts`: Sequential frame extraction and local thumbnail cache.
- `server/media.ts`: Read-only video streaming with byte-range support.
- `shared/`: Frontend/backend types.

The backend listens on a random loopback port with a per-launch token. The frontend requests status through the preload bridge; it has no direct Node.js or filesystem access. Closing the last window or using Cmd+Q quits the app and stops the backend. Frontend edits reload automatically; restart development after changing backend code.

Ingestion and durable recovery features are future work. Develop against isolated dummy folders; reading an explicitly selected source is read-only. Real NAS access requires explicit configuration and authorization.
