# OWMO Shot Manager

OWMO Shot Manager is a local macOS desktop app for browsing original video footage from cards and folders, inspecting clips, and assigning per-shot attributes. The planned Import workflow will ingest footage into a canonical NAS Library. **Ingestion is not implemented yet.**

## Requirements

- macOS, Node.js 22.12+, and npm
- FFmpeg and FFprobe available on `PATH`

## Run locally

```sh
npm install
npm run dev
```

Viewing LUTs are included in the repository. See [LUT provenance](resources/luts/README.md). `npm run build` checks TypeScript and creates `out/` with the LUTs; `npm start` opens that build. This repository does not currently produce an installable app.

## Current functionality

- Add multiple card or folder sources, browse original videos by recording date, filter by source/device, inspect technical metadata, and play or seek the original video. Clips appear after fingerprinting and attribute loading; their identity follows the fingerprint across moves and rescans. When loaded locations share a fingerprint, the grid prefers an available location, then an editable one, within the source filter. The backend queues thumbnail generation for every identified clip during scanning, independently of card visibility or renderer reloads, using one worker and reusing cached/custom previews. Scanning continues while thumbnails are pending; preview failures do not prevent clips appearing. The grid loads cached images as cards approach the viewport. Camera proxies, thumbnails, and external XML are not used.
- Edit Identity, Project, Scene, Notes, and Tags per clip. Drafts may be incomplete; future ingestion requires Identity and Project. Attributes and Skip choices persist locally; source lists and editing selections are session-only. Skipping a clip is separate from selecting it for inspection.
- Use the inspector's LUT toggle to review supported Sony S-Log3 and Apple Log footage. Viewing transforms and cached previews do not change source files.
- Set a Library location in Configuration. This only saves a path; it does not scan or write to the Library. **Review & Ingest remains disabled.**

Configuration's **Reset Local Data** requires confirmation and deletes local clip drafts, Identity/Project lists and session tag suggestions, fingerprints, previews, sources, selections, and skip choices. It preserves app configuration, LUTs, source footage, and Library files. Sources must be added again afterward. Removing a saved option or clearing selected clips' attributes is a narrower operation.

The inspector orders fields as **Identity → Project → Scene → Notes → Tags**. Scene is an optional short sentence, saved with each clip like Notes, with no suggestion list. It allows up to 80 characters: Unicode letters and numbers, spaces, apostrophes, commas, periods, and hyphens. Curly apostrophes and long dashes normalize to plain punctuation; extra spaces are collapsed. Notes has a larger six-line editor, and the default window keeps all attribute fields visible. The character policy does not define Library filenames; final filename construction remains a later step.

Identity and Project options persist; Tag suggestions reflect tags used by currently loaded clips, while clip tags remain saved in drafts. Removing Identity or Project options in Configuration clears only the matching field across local clip records. **Save** shows an affected-clip count and table distinguishing active and saved clips before confirmation; unused entries are deleted directly. No rescan is triggered. Other attributes stay intact. Removal waits for active scans to finish; changed attributes require a fresh review. Older saved records without a filename show a clip identifier until scanned again.

Unreadable or invalid saved drafts, configuration, and fingerprint records are preserved and reported. A clip whose fingerprint or draft cannot be loaded is skipped during discovery; source scan issue details appear in the source's tooltip. Reset Local Data remains an explicitly confirmed operation.

Failed clip edits remain in the main process for the current app session, including across inspector changes and renderer reloads. An app-level banner offers retry; later edits wait behind failed edits so retry preserves their order. Source changes, option removals, and reset wait for successful saves. The window close button and Command+Q use the same exit path: finish accepted edits, stop the backend, then close the window. The window displays shutdown progress while background work stops; failed saves offer Keep Working, Retry Saves, or an explicit Quit Without Saving. Retained unsaved edits are in memory, not a crash-recovery journal.

Clip fingerprints use `sampled-sha256-v2`: file size, the fixed sampling scheme and byte ranges, and bytes read from the original file. Large files use five 256 KiB samples spread from the start to the end; files up to 1.25 MiB are read in full. Extracted metadata, paths, and filesystem dates do not contribute to clip identity. Filesystem details only invalidate cached reads and detect changes during inspection. A sampled fingerprint associates local drafts and previews; it does not prove duplicate content or transfer integrity. Ingestion will require full-file SHA-256 verification. This development change does not migrate earlier fingerprint records or their associated drafts/previews.

## Development

The app uses Electron and React in `desktop/` and `client/`, a local Fastify backend in `server/`, and shared types in `shared/`. The renderer accesses files through restricted preload/backend interfaces. The backend runs in a separate Electron utility process.

Clip attribute keys are `identity`, `project`, `scene`, `notes`, and `tags`: Identity/Project are nullable single values, Scene/Notes are text, and Tags is a list. The independent `skipped` boolean persists with the draft, defaults to false, and is preserved by Clear. Older `projects`/`context` records migrate atomically to `project`/`tags`, with prior multiple-project assignments retained in recovery metadata. Scene and Notes have separate debounce keys and share the main-process save/retry/quit handling.

IPC carries structured error data so messages, codes, HTTP status, and unknown mutation outcomes survive the preload boundary. Backend reads have a 15-second deadline; mutations wait for a response. A lost mutation response is reported as an unknown outcome, rather than claiming cancellation. Only the existing idempotent clip-attribute commands are retained for explicit ordered retry; future ingestion still needs durable job IDs and a journal.

Source listing returns cached state without touching media. Backend monitoring checks source roots every five seconds, independently of renderer polling; camera presentation is inspected on add, refresh, re-link, or actual root replacement. Change events carry revision notices instead of collections. The renderer coalesces notices over 250 ms and permits one snapshot request at a time; vocabulary has its own revision so preview, Notes, and Skip changes do not reload suggestions.

Clip-attribute edits still save atomically before acknowledgment. Scan-only bookkeeping is batched in groups of up to 64 records and flushed on scan completion and graceful shutdown. An abrupt process exit can lose the latest bookkeeping batch, while acknowledged attribute edits remain saved.

```sh
npm run typecheck
npm run check:configuration
npm run check:communication
npm run check:organization
npm run check:selection
npm run check:quit
```

The checks use temporary fixtures. Develop ingestion against dummy folders only; real NAS access requires explicit authorization and mounted-volume validation. See [AGENTS.md](AGENTS.md) for project safety and implementation constraints.
