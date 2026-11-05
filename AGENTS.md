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
- Draft fields may be empty; Identity and Project are required before ingestion. Context tags and Notes are optional. Persist Identity/Project options; keep Context suggestions as a session-only list of tags used by loaded clips while preserving tags in clip drafts. Keep editing selection distinct from the current skip state: discovered clips are included by default, and an explicit skip excludes them from future ingest. Do not reintroduce a separate ingest checkbox. See the code and `README.md` for interaction details.
- Configuration Identity/Project deletions clear only the matching field and cascade to all saved local clip drafts, including offline records, after an affected-clip review distinguishing active and saved records. Unused entries need no extra confirmation. Apply atomically, preserve unrelated attributes, reject stale reviews/scan conflicts, and update loaded clips without rescanning. This does not authorize changes to source footage or Library files.
- Local drafts, configuration, fingerprint records, and disposable previews have different retention and reset semantics. `Reset Local Data` clears all local drafts, options, fingerprints, previews, sources, selections, and skips after confirmation; it preserves configuration, LUTs, source footage, and Library files. Clearing selected clips' attributes or removing vocabulary entries has narrower effects.
- Publish clips only after fingerprint and attributes are ready; use the fingerprint as the clip ID across selection, editing, and asset lookup. Keep file locations separate.
- A sampled fingerprint associates local drafts/previews with matching media; it is not proof of duplicate content or transfer integrity. Only full-file SHA-256 calculated from actual bytes can verify a transfer.

## Future ingest requirements

- Implement planning and explicit review before execution. Show exact destinations, file mappings, duplicates, and conflicts. Block queueing clips missing Identity or Project. Do not finalize the NAS naming convention from historical examples.
- Before copying, durably persist an immutable per-shot queue snapshot and lock queued/processing/failed shots against draft edits. Execute from that snapshot, not mutable UI state. Backend work continues across renderer reloads; restart recovery uses a durable local journal.
- Start with one active job and one transfer at a time. Never silently overwrite unrelated destination data. Verify copied bytes with source/destination SHA-256, then atomically finalize per-shot JSON. A folder's existence or a successful copy command does not establish completion.
- Revalidate sources, destination mount, journal, and partial files on retry/restart. Handle interruption, disconnects, checksum mismatches, collisions, cancellation, and duplicate attempts without losing recovery evidence or creating duplicate completed shots.
- Use dry-run plans and fault tests on dummy folders before requesting authorization for any real NAS write.

## Working in this repository

- Find current implementation details in `README.md` and the adjacent code. Keep changes focused; update documentation when behavior changes. Do not turn this file into a feature log or append superseded decisions to it.
- `npm run dev` starts the app; `npm run typecheck` and `npm run build` validate TypeScript/build output. Relevant focused checks are `npm run check:configuration`, `npm run check:organization`, `npm run check:selection`, and `npm run check:quit`. Run the checks affected by a change using temporary fixtures only.
- Never use real cards or NAS locations as test fixtures. Preserve user changes already present in the working tree.
