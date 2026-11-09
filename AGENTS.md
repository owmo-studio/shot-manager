# OWMO Shot Manager — agent guidance

## Purpose and scope

OWMO Shot Manager is a single-user, local macOS Electron app for reviewing original video footage from cards and folders, editing per-shot attributes, and eventually ingesting selected footage into a canonical NAS Library. It manages an active working library, not an archive.

The current priority is to complete and validate Import using isolated dummy sources and destinations. Library browsing/editing, NAS-to-local Edit sync, editor-specific layouts, proxy generation, and deletion are deferred. Discuss those features before implementing them.

Read the relevant code and `README.md` for current behavior. Treat this file as durable constraints, not a complete product specification. If older documentation conflicts with working code or a new user instruction, resolve the discrepancy before changing behavior.

## Non-negotiable safety

- Source footage is read-only. Never rename, delete, overwrite, transcode, or reorganize original media as part of discovery, inspection, or testing.
- Never read, write, or mutate real NAS media during prototyping without explicit authorization for that operation. Use temporary dummy folders and synthetic media in automated tests. A configured Library path alone does not authorize NAS access.
- Before any future Library write, validate the configured destination and mounted volume. A missing SMB mount must never turn into a write to its empty local mount-point directory. Do not use example paths as defaults.
- Preserve corrupt or unreadable persisted state and report the error; do not silently replace it. Keep destructive local-data operations explicitly confirmed and confined to recognized app-owned files.
- Backend filesystem routes accept validated asset identifiers, never arbitrary renderer-supplied paths. Keep Electron's preload restricted and the backend bound to authenticated loopback access.

## Architecture and data

- Keep the existing Electron/electron-vite, React/TypeScript, Fastify, and `shared/` structure. The backend runs as a separate Electron utility process; renderer reloads must not own or cancel backend jobs. Avoid new services, databases, or dependencies without a concrete need.
- Inspect each original video independently. Source-derived technical metadata is read-only; unknown or conflicting values remain explicit. Do not infer device, codec, color, or capture date from folder names, camera proxies, or external XML. Playback and previews use originals; cached thumbnails are disposable.
- All assigned attributes (Identity, Project, Scene, Notes, and Tags) are optional, including at ingestion. Persist Identity/Project options; keep Tag suggestions as a session-only list of tags used by loaded clips while preserving tags in clip drafts. Keep editing selection distinct from the current skip state: discovered clips are included by default, and an explicit skip excludes them from future ingest and persists in the fingerprint-keyed local draft. Clearing attributes preserves Skip. Do not reintroduce a separate ingest checkbox. See the code and `README.md` for interaction details.
- Configuration Identity/Project deletions clear only the matching field and cascade to all saved local clip drafts, including offline records, after an affected-clip review distinguishing active and saved records. Unused entries need no extra confirmation. Apply atomically, preserve unrelated attributes, reject stale reviews/scan conflicts, and update loaded clips without rescanning. This does not authorize changes to source footage or Library files.
- Local drafts, configuration, fingerprint records, and disposable previews have different retention and reset semantics. `Reset Local Data` clears all local drafts, options, fingerprints, previews, sources, selections, and skips after confirmation; it preserves configuration, LUTs, source footage, and Library files. Clearing selected clips' attributes or removing vocabulary entries has narrower effects.
- Publish clips only after fingerprint and attributes are ready; use the fingerprint as the clip ID across selection, editing, and asset lookup. Keep file locations separate.
- A sampled fingerprint associates local drafts/previews with matching media and is the Library ID; it is not proof of duplicate content or transfer integrity. Successful rsync completion is the accepted transfer-success criterion; do not add a separate full-file SHA-256 pass.

## Agreed Library storage

- These are agreed requirements for upcoming implementation, not a description of completed ingestion functionality. They supersede older documentation requiring Identity/Project, full-file SHA-256 verification, or durable queue recovery.
- Start with a flat Library: `<full-lowercase-sampled-fingerprint>.<role>.<ext>`. Reserved roles are `source`, `thumb`, `metadata`, and optional `proxy`, with one published asset per role per shot initially. Preserve the source's original format extension, normalized to lowercase; generated assets use their actual format's extension. Preserve the original source filename in metadata JSON.
- Ingestion creates the original video, the current generated or assigned thumbnail, and metadata JSON. Always include every attribute field, even when empty: `identity: null`, `project: null`, `scene: ""`, `notes: ""`, and `tags: []`. The remaining JSON field contract is still to be defined.
- Other software will monitor the Library and add derived assets such as proxies. Discover optional assets by fingerprint and role; no separate asset-inventory manifest or centralized database is required. Keep the internal contract simple; schema versioning and multi-writer coordination machinery are not required. Leave existing proxies and other additional assets untouched during ingestion.
- Readers ignore temporary/partial filenames. Let rsync use its temporary-file-and-rename behavior; do not expose an in-progress transfer under its final filename. Publish metadata JSON atomically and last, after source and thumbnail transfers succeed. Existing JSON during a replacement describes the previous completed ingestion until replaced.
- Future browsing should use a disposable local catalog backed by the Library files. Avoid unnecessary per-asset inspection during catalog discovery. Centralize relative-path construction so fingerprint-prefix buckets can be introduced later if measured SMB performance warrants them; do not implement buckets now.

## Agreed ingest queue

- Eligible clips are not skipped, already queued, or synced in their current state. Each must have an available source video and a ready generated or assigned thumbnail; missing attributes do not block ingestion. Enable Review & Ingest when the candidate list is nonempty and ready. Validate the configured Library destination and mount before execution.
- Review & Ingest opens a simple confirmation with count, total size, and a scrollable clip list marked New or Replace. An X removes a row from this submission without changing its saved Skip state. Cancel makes no queue changes; Ingest authorizes queueing and replacement for the remaining rows. Detect existing fingerprint matches during review and recheck before writing; a newly discovered conflict requires a decision rather than an unreviewed overwrite.
- Capture an immutable in-memory snapshot of each accepted clip's source, thumbnail, attributes, and destination. Lock waiting and processing clips against edits and execute from the snapshot. Use one queue with one active clip and one transfer at a time. Backend processing survives renderer reloads. Show active transfer progress, followed by metadata publication before marking completion.
- While the queue is active, replace the footer's idle `N clips to ingest · Y skipped` summary with `N / T clips ingesting`, where N is the current clip's position in the queue and T is the total submitted clip count. Restore the idle summary when the queue finishes or is stopped.
- Use rsync for the source and thumbnail. Preserve source modification times and use rsync's size/mtime quick check to avoid recopying unchanged files; existence alone is insufficient. Metadata-only changes should update JSON without recopying unchanged video. A successful transfer followed by successful JSON publication completes ingestion.
- Persist the last successful ingestion state alongside the fingerprint-keyed local draft, including the Library destination and the attributes/thumbnail state needed to recognize changes. Show Synced for an unchanged successful ingestion and exclude it from subsequent submissions. Attribute or thumbnail changes show Changes pending and make it eligible again; Skip and editing selection do not invalidate sync state. Recognize reverted edits when they match the last successful state. Sync status is not an assertion that remote assets have been independently reverified.
- Enable Stop Queue beside Review & Ingest while work exists. After confirmation, clear waiting entries and terminate the active transfer, then unlock cancelled clips and restore their pre-queue state. Preserve completed ingestions and synced checkmarks. A cancelled replacement retains the previous successful ingestion record and any pending-change indication. Do not mark cancelled work synced. Cleanup of orphaned/partial Library data is deferred.
- On failure, show a dialog identifying the clip and available error details, remove and unlock that entry, and continue the remaining queue. Preserve any previous successful ingestion record. Retained failed entries, retry workflows, and orphan cleanup are deferred.
- The queue is not persisted. An application crash or restart discards unfinished queue work; no durable journal, automatic resume, or recovery workflow is required. Usual local draft persistence and successful-ingestion state survive. A renderer reload is not an application restart and must not cancel backend work.
- Use dry-run plans and fault tests on dummy folders before requesting authorization for any real NAS write.

## Working in this repository

- Find current implementation details in `README.md` and the adjacent code. Keep changes focused; update documentation when behavior changes. Do not turn this file into a feature log or append superseded decisions to it.
- `npm run dev` starts the app; `npm run typecheck` and `npm run build` validate TypeScript/build output. Relevant focused checks are `npm run check:configuration`, `npm run check:organization`, `npm run check:selection`, and `npm run check:quit`. Run the checks affected by a change using temporary fixtures only.
- Never use real cards or NAS locations as test fixtures. Preserve user changes already present in the working tree.
