# OWMO Shot Manager

OWMO Shot Manager is a local macOS desktop app for browsing original video footage from cards and folders, inspecting clips, and assigning per-shot attributes. Process prepares and places clips where they belong, with their associated assets, metadata, and transformations captured. The current Import workflow copies original footage and thumbnails into the canonical Library and publishes metadata through a reviewed background queue; additional transformations, such as proxy encoding, belong to the planned background-worker workflow. Development validation uses isolated dummy sources and local destinations; real NAS validation remains pending.

## Requirements

- macOS, Node.js 22.12+, and npm
- macOS bundled `/usr/bin/rsync` (or compatible openrsync)
- FFmpeg and FFprobe available on `PATH`

## Run locally

```sh
npm install
npm run dev
```

Viewing LUTs are included in the repository. See [LUT provenance](resources/luts/README.md). `npm run build` checks TypeScript and creates `out/` with the LUTs; `npm start` opens that build. This repository does not currently produce an installable app.

## Current functionality

- Add multiple card or folder sources, browse original videos by recording date, filter by source/device, inspect technical metadata, and play or seek the original video. Clips appear after fingerprinting and attribute loading; their identity follows the fingerprint across moves and rescans. When loaded locations share a fingerprint, the grid prefers an available location, then an editable one, within the source filter. The backend queues thumbnail generation for every identified clip during scanning, independently of card visibility or renderer reloads, using one worker and reusing cached/custom previews. Scanning continues while thumbnails are pending; preview failures do not prevent clips appearing. The grid loads cached images as cards approach the viewport. Camera proxies, thumbnails, and external XML are not used.
- Edit Identity, Project, Scene, Notes, and Tags per clip. All assigned attributes are optional, including when processing clips. Attributes and Skip choices persist locally; source lists and editing selections are session-only. Successful processing receipts persist with local drafts. Skipping a clip is separate from selecting it for inspection.
- Use the inspector's LUT toggle to review supported Sony S-Log3 and Apple Log footage. Viewing transforms and cached previews do not change source files.
- Set a Library location in Configuration. The app checks the mounted destination and lists its asset filenames on startup, after choosing the location, and before processing review. This presence check does not open media or JSON contents or write to the Library. **Process** confirms an explicit clip list before queueing transfers. See the processing behavior below.

Configuration's **Reset Local Data** requires confirmation and deletes local clip drafts, Identity/Project lists and session tag suggestions, fingerprints, previews, sources, selections, and skip choices. It also clears local processing receipts, and preserves app configuration, LUTs, source footage, and Library files. Sources must be added again afterward. Removing a saved option or clearing selected clips' attributes is a narrower operation.

The inspector orders fields as **Identity → Project → Scene → Notes → Tags**. Clear and Revert sit at the bottom-left of the attributes panel, with the Saving status aligned right on the same row for single and multiple selections. Revert is enabled for selected clips with pending updates and requires confirmation before replacing their local Identity, Project, Scene, Notes, and Tags with the current Library JSON values. In a mixed selection it applies only to clips with pending updates. It reads only those metadata files on demand after validating the configured Library volume; normal presence scans still read filenames only. It preserves Skip, thumbnails, and processing receipts, so a changed thumbnail or missing Library asset may still need processing. A missing or invalid metadata file rejects the whole selection without changing local attributes; successful restores refresh the inspector immediately and retain restored Identity/Project options. Scene is an optional short sentence, saved with each clip like Notes, with no suggestion list. It allows up to 80 characters: Unicode letters and numbers, spaces, apostrophes, commas, periods, and hyphens. Curly apostrophes and long dashes normalize to plain punctuation; extra spaces are collapsed. Notes has a larger six-line editor, and the default window keeps all attribute fields visible. The character policy does not affect fingerprint-based Library filenames.

Identity and Project options persist; Tag suggestions reflect tags used by currently loaded clips, while clip tags remain saved in drafts. Removing Identity or Project options in Configuration clears only the matching field across local clip records. **Save** shows an affected-clip count and table distinguishing active and saved clips before confirmation; unused entries are deleted directly. No rescan is triggered. Other attributes stay intact. Removal waits for active scans to finish; changed attributes require a fresh review. Older saved records without a filename show a clip identifier until scanned again.

Unreadable or invalid saved drafts, configuration, and fingerprint records are preserved and reported. A clip whose fingerprint or draft cannot be loaded is skipped during discovery; source scan issue details appear in the source's tooltip. Reset Local Data remains an explicitly confirmed operation.

Failed clip edits remain in the main process for the current app session, including across inspector changes and renderer reloads. An app-level banner offers retry; later edits wait behind failed edits so retry preserves their order. Source changes, option removals, and reset wait for successful saves. The window close button and Command+Q use the same exit path: finish accepted edits, stop the backend, then close the window. The window displays shutdown progress while background work stops; failed saves offer Keep Working, Retry Saves, or an explicit Quit Without Saving. Retained unsaved edits are in memory, not a crash-recovery journal.

Clip fingerprints use `sampled-sha256-v2`: file size, the fixed sampling scheme and byte ranges, and bytes read from the original file. Large files use five 256 KiB samples spread from the start to the end; files up to 1.25 MiB are read in full. Extracted metadata, paths, and filesystem dates do not contribute to clip identity. Filesystem details only invalidate cached reads and detect changes during inspection. A sampled fingerprint associates local drafts and previews; it does not prove duplicate content or transfer integrity. Processing accepts successful rsync completion without a separate full-file SHA-256 pass. Rsync uses size and modification time to skip unchanged destination files; this is not independent verification of stored destination bytes. This development change does not migrate earlier fingerprint records or their associated drafts/previews.

## Library and processing

The Library is flat. Asset filenames are `<full-lowercase-sampled-fingerprint>.<role>.<ext>`:

```text
<id>.source.mp4
<id>.thumb.jpg
<id>.metadata.json
<id>.proxy.mov       # optional, created by other software
```

Sources retain their original format extension, normalized to lowercase. Processing copies the original video and current generated or custom thumbnail with rsync, then atomically publishes metadata JSON last. Other tools can discover additional assets using the ID and role; processing leaves proxies and other additional assets untouched. Temporary and partial filenames are not published assets. Bucket directories, a shared database, and asset-inventory manifests are not used.

The metadata JSON contains `id`, `fingerprint` (including its sampling scheme), `originalFilename`, `bytes`, `recordedAt`, `dateSource`, `dateEvidence`, `dateConfidence`, `durationSeconds`, `metadata` (the existing technical metadata structure), `warnings`, and `ingestion: { completedAt, transfer: "rsync" }` (the existing stored field for processing completion). It always includes all five assigned attributes: `identity` and `project` are strings or `null`, `scene` and `notes` are strings (including `""`), and `tags` is an array (including `[]`). No schema version is required. The original source filename is preserved even though storage uses the fingerprint.

Non-skipped clips need an available original and a ready thumbnail; empty attributes do not block processing. Already synced and queued clips are excluded. Review shows count, source-plus-thumbnail size, exact file mappings, and New/Update rows. X removes a clip from that submission without setting Skip. Confirming Process authorizes replacement for remaining Update rows. Changed source/destination state invalidates review; a later conflict fails the affected entry for a fresh review. Existing source/thumbnail assets with a different extension block processing to avoid ambiguous roles.

The backend captures immutable in-memory clip snapshots, locks queued/processing clips, and runs one transfer at a time. Processing state and throttled progress snapshots are pushed through backend/main/preload notifications; the footer reads initial state on connection/reload and does not poll while idle or active. The footer keeps its idle height during processing: a centered `N / T`, green progress bar, matching small percentage text, and a compact round transparent button with a grey X that turns red on hover or press share one vertically centered line, without a filename below. Transfer progress is weighted by source and thumbnail bytes and capped at 99% until metadata publication, local receipt persistence, and completion cleanup succeed; only then is 100% reported. There is no outline or card background. Queued and processing cards have grey backgrounds, dimmed media, and grey status text; only the active transfer gently pulses with a grey border and glow, respecting reduced-motion preferences. Synced cards use a steady green background and border with a checkmark in the thumbnail’s top-right corner. Clips with existing core Library assets that need processing use yellow styling and a pencil icon in the thumbnail’s top-right corner; genuinely new clips retain the neutral style. Both icons retain descriptive hover text and accessible labels. This includes missing required assets and existing Library clips without a matching local receipt, so card status agrees with New/Update review without opening Library file contents. Editing selection remains visible over the status color. Process uses the blue primary button style. Success publishes JSON and saves a local receipt for that Library, attributes, and thumbnail content. Unchanged clips show Synced only when the latest Library listing contains exactly one source file plus the thumbnail and metadata JSON for that ID. Attribute or thumbnail changes show Needs Syncing; reverting to the last successful state restores Synced. Selection and Skip do not change the receipt. Normal draft expiry retains records with successful processing receipts; Reset Local Data explicitly clears them. Receipts record the last successful descriptive state; a session-only filename cache checks asset presence, not file contents or transfer integrity. Missing required assets clear the Synced badge and make the clip eligible again. If all three required assets were deleted, review shows New; remaining assets still require Update approval. While the Library is being checked or is unavailable, saved receipts remain intact and their clips show Library not verified. An unavailable Library is never treated as an empty Library. The refresh icon immediately left of Configuration in the top-right toolbar updates this check after external edits without restarting; it spins and is greyed out while checking, with no refresh indicator in the footer, and is disabled during processing. Checks are coalesced and are not polled in the background.

Rsync preserves source modification times and uses its size/mtime quick check to avoid recopying unchanged videos when metadata changes. Thumbnails are copied from a private temporary snapshot. Library directory listings are shared across each review/submission; execution checks the known target paths. Choosing the Library records its mounted volume in configuration; older settings require choosing the Library again before processing clips. The destination must already exist, be separate from sources, match that configured volume, and retain its reviewed folder/mount identity. Missing `/Volumes` mounts, symlink assets, and unreviewed target changes are rejected; the app never creates a missing Library root. Source changes, option removal, cache clearing, and local reset are blocked while clips are queued. Changing the configured Library is also blocked while processing is active.

A compact round transparent button with a grey X that turns red on hover or press for Stop Queue sits within the active progress display, beside the bar and percentage; it is hidden when the queue is idle. Its compact confirmation has Cancel and a red Stop button, with the completion note on a new line. Stop Queue clears waiting entries, stops the active rsync process, and unlocks cancelled clips. Successfully processed clips retain their checkmarks. A cancelled replacement keeps the previous receipt and pending-change indication. Failure displays the clip and error, removes/unlocks that entry, and continues the queue. Cleanup of orphaned destination data and retry workflows are deferred. Owned temporary JSON and local staging files are removed when possible.

The queue survives renderer reloads, but is not persisted across application crashes/restarts. Graceful shutdown stops transfers before closing the backend. Only the usual drafts and successful processing receipts persist; there is no durable queue journal or automatic resume. A crash between Library publication and receipt persistence can leave a processed Library shot without a local checkmark; it will appear as Update in a subsequent review.

Library browsing/editing and its disposable local catalog remain future work. Validate processing with dummy folders only; real NAS reads/writes require explicit authorization for that operation.

## Development

The app uses Electron and React in `desktop/` and `client/`, a local Fastify backend in `server/`, and shared types in `shared/`. The renderer accesses files through restricted preload/backend interfaces. The backend runs in a separate Electron utility process.

Clip attribute keys are `identity`, `project`, `scene`, `notes`, and `tags`: Identity/Project are nullable single values, Scene/Notes are text, and Tags is a list. The independent `skipped` boolean persists with the draft, defaults to false, and is preserved by Clear. Older `projects`/`context` records migrate atomically to `project`/`tags`, with prior multiple-project assignments retained in recovery metadata. Scene and Notes have separate debounce keys and share the main-process save/retry/quit handling.

IPC carries structured error data so messages, codes, HTTP status, and unknown mutation outcomes survive the preload boundary. Backend reads have a 15-second deadline; mutations wait for a response. A lost mutation response is reported as an unknown outcome, rather than claiming cancellation. Only the existing idempotent clip-attribute commands are retained for explicit ordered retry; processing submissions are not automatically retried. If a submission response is lost, the UI checks current queue status instead of assuming nothing was queued.

Source listing returns cached state without touching media. Backend monitoring checks source roots every five seconds, independently of renderer polling; camera presentation is inspected on add, refresh, re-link, or actual root replacement. Change events carry revision notices instead of collections. The renderer coalesces notices over 250 ms and permits one snapshot request at a time; vocabulary has its own revision so preview, Notes, and Skip changes do not reload suggestions.

Clip-attribute edits still save atomically before acknowledgment. Scan-only bookkeeping is batched in groups of up to 64 records and flushed on scan completion and graceful shutdown. An abrupt process exit can lose the latest bookkeeping batch, while acknowledged attribute edits remain saved.

```sh
npm run typecheck
npm run check:configuration
npm run check:communication
npm run check:organization
npm run check:selection
npm run check:quit
npm run check:ingestion
npm run check:ingestion-ui
```

The checks use temporary fixtures. Develop processing against dummy folders only; real NAS access requires explicit authorization and mounted-volume validation. See [AGENTS.md](AGENTS.md) for project safety and implementation constraints.
