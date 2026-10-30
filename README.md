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

The combined shot grid groups by recording date and orders oldest first. Sony XML timestamps retain their recorded offsets; embedded creation timestamps are the next choice. If neither is available, file modification time is shown explicitly as a fallback. FFprobe reads original-file metadata with an eight-second timeout. An unreadable, unsupported, or damaged video candidate remains visible with a metadata warning where possible; it is not declared verified or ready for ingestion. Unreadable files or subfolders are reported while independent work continues. Failed or interrupted scans retain the clips already discovered.

Original video alone is sufficient: XML, proxies, and thumbnails are all optional. Existing JPEG thumbnails load on demand; missing, invalid, oversized, or unreadable thumbnails use a placeholder. No thumbnails are generated, nothing is transcoded, and source media is never modified. Per-source clip counts update as scanning progresses. Playback, selection, metadata editing, and ingestion are still future work.

Sources last only for the current backend session. Previous `sources.json` files are no longer read or written. Selected paths are rechecked about every five seconds: missing or inaccessible roots remain in the list as unavailable, with a popup once per outage. Restoring the path clears the unavailable state; a later outage can notify again. Renamed or moved folders can be removed and added at their new location. Changed root identity or sampled metadata creates a fresh source ID. This is live detection, not a guarantee of physical card identity; ingestion will need stronger source validation. Camera models reflect the metadata sample, not an assertion that every shot uses the same camera. No shot-specific configuration is reused between cards.

Use **×** beside a source to remove it from the list without deleting or changing any files. Disconnecting or renaming a source stops any active scan but retains discovered shots and already-loaded thumbnails in the grid. Those shots show a red unavailable state and are flagged non-editable by the backend; future editing and ingestion must enforce source availability. Scans are not automatically repeated on reconnection. Removing a source explicitly clears its shots; replacement source identities also discard old results. Sources and shots remain session-only. The central **+** opens the same picker as **+ Add Source**. Folders or mounted cards can also be dragged from Finder onto the main workspace, including after sources have been added. Individual file drops are rejected. The native picker belongs to the desktop shell; source registration, discovery, and metadata inspection belong to the backend.

`npm run build` checks TypeScript and builds into `out/`. `npm start` opens that build; it does not create an installable application.

## Structure

- `desktop/`: Electron lifecycle and restricted preload bridge.
- `client/`: React interface, styled with Tailwind via Vite.
- `server/`: Fastify service in a supervised Electron utility process.
- `server/discovery.ts`: Sony/generic discovery and optional media metadata.
- `server/scanner.ts`: Background scan lifecycle, cancellation, cached results, and controlled thumbnail reads.
- `shared/`: Frontend/backend types.

The backend listens on a random loopback port with a per-launch token. The frontend requests status through the preload bridge; it has no direct Node.js or filesystem access. Closing the last window or using Cmd+Q quits the app and stops the backend. Frontend edits reload automatically; restart development after changing backend code.

Ingestion and durable recovery features are future work. Develop against isolated dummy folders; reading an explicitly selected source is read-only. Real NAS access requires explicit configuration and authorization.
