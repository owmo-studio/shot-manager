# OWMO Shot Manager — agent guidance

## Scope

This is a single-user, local macOS Electron app for Import → Library → Resolve export. Keep changes focused; avoid speculative refactors, new services/databases, and unnecessary dependencies. README covers operation; adjacent code and `shared/` types define the detailed contracts. Do not expand these documents into feature logs. Resolve plugins/importers and expanded search require discussion before implementation.

## Safety

- Original source footage is read-only. Never rename, overwrite, delete, transcode in place, or reorganize it during discovery, inspection, or testing.
- Tests use isolated temporary folders and synthetic media. A configured Library does not authorize agent access to real NAS media; obtain explicit authorization for any such operation.
- Before Library/export mutations, validate the mounted volume, folder identity, and reviewed file identities. A missing SMB mount must never become a write to its empty local mount point. Reject symlink/linked assets where existing guards require it; never recursively delete Library folders. Configuration allows distinct nested folders; do not add broad parent/child exclusions.
- Preserve and report corrupt persisted state. Destructive operations require explicit confirmation and must stay within reviewed Library assets or recognized app-owned cache files.
- Keep preload restricted, filesystem routes identifier-based, destination paths native-picker capabilities, and the backend on authenticated loopback. Preserve structured errors and unknown mutation outcomes; do not automatically retry non-idempotent submissions.

## Architecture and workspace

- Keep Electron/electron-vite, React/TypeScript, Fastify, and `shared/`. The backend utility process owns jobs; renderer reloads must not cancel them. Notifications carry revisions/status snapshots rather than polling media or asset inventories.
- Inspect each original independently. Technical metadata is read-only; unknown/conflicting evidence stays explicit. Do not infer device, codec, color, or dates from folders, camera proxies, or external XML. Playback uses originals; LUTs are viewing aids only.
- The sampled fingerprint is the clip/Library ID, not proof of duplicate content or transfer integrity. Accept successful rsync completion; do not add a full-file hash pass.
- The workspace owns one record and active path per fingerprint. Discovery is additive and temporary, with no retained Source registry. Keep healthy paths/current edits; adopt a matching freshly fingerprinted copy only when the old path is unavailable. Never switch a queued snapshot's captured path.
- Monitor only referenced clip-containing directories for existence; stop monitoring when unreferenced. Revalidate individual files on access/recovery using filesystem identity. Preserve offline edits and manual Stop state; reject changed files until fresh discovery.
- Attributes are optional. Keep Quality's persisted `rating` key and all empty attribute fields in JSON. Selection and persistent Skip are separate; Clear preserves Skip. Identity/Project options persist; Tag suggestions are session-only. Option removal cascades atomically through matching local drafts, including offline records, after affected-clip review; it never edits Library media/JSON.
- Keep failed edits in ordered main-process save/retry handling. Quit drains accepted edits and stops backend work; failed saves require retry, continued work, or explicit discard. Retained edits/queues are not crash-recovery journals.

## Library and local data

- Storage is flat: `<full-lowercase-sampled-fingerprint>.<role>.<ext>`. Reserved roles: source, proxy, thumb, metadata, with one published asset per role. Preserve the source format extension in lowercase and original filename in JSON. Keep schema/storage simple: no central database, inventory manifest, or versioning machinery without need.
- Rsync uses temporary-file rename and size/mtime quick checks. Publish metadata atomically **last**, after media transfers; preserve technical/extra JSON fields and existing regular proxies/other derived assets. Readers ignore partial files. Persist receipts only after successful publication; cancellation racing a completed publication must preserve that success.
- Catalogue and fingerprint-keyed drafts are separate. Refresh uses at most four JSON readers, preserves pending edits/unreadable records/offline catalogue data, and never discovers/probes/encodes Library rows. Load thumbnails/playback on demand. Synced requires matching receipt/attributes/thumbnail and verified asset presence; unavailable storage is unverified, never empty.
- Revert restores selected descriptive attributes **and thumbnail** from validated Library assets as an atomic local batch. Preserve Skip/receipts; reject stale edits or invalid/missing assets without partial restoration and roll back staged thumbnails on save failure.
- Cache is app-managed in `Shot Manager Cache` beside Electron's cache; no user location setting. Library choices stay pending until Save. Clear Cache confirms selective categories and preserves Library settings/media; retain workspace paths/exclusions across its backend restart. Leave older cache locations untouched. After 90 days without use, expire clip data at graceful shutdown; preserve saved options and corrupt records until explicit clearing.
- Proxy preset: ProRes 422 Proxy MOV, 10-bit 4:2:2, maximum 1280-pixel long edge, no upscaling, preserved aspect/orientation, timing/timecode, and audio channels. No baked LUTs or invented color declarations. Reuse complete Library/cache proxies; publish cache files by rename on success, guard free space/folder identity, and remove matching cache proxies only after Library publication and receipt persistence.

## Jobs and actions

- One proxy encoder, one Commit worker, and one Export worker may run concurrently; thumbnails have their own worker. Shared fingerprint locks prevent concurrent operations on the same clip. Capture immutable reviewed snapshots and lock submitted clips; serialize validation without blocking unrelated workers. Appended submissions retain active progress/history.
- Commit uses eligible selected clips, or all eligible workspace clips without selection; never fall back from an ineligible selection. Skip excludes clips. Source and thumbnail availability are required, attributes are not. Ready clips bypass submissions awaiting proxies. Submitted clips get encode priority; preempt only an unsubmitted encode strictly below 20%, remove its partial output, and restart it later. Never preempt finishing publication.
- Successful Import publication updates the catalogue and removes that workspace card. Review may include Synced cards for workspace removal only; cancellation/exclusion keeps them. Per-clip Stop cancels submitted work but keeps clips; Eject removes unqueued workspace membership after confirmation, preserving media/drafts/receipts and preventing late callbacks from restoring cards.
- Toolbar Stop clears proxy/Commit/Export queues and pauses automatic encoding; thumbnails continue. Refresh resumes missing preparation, never cancelled transfers. Late reviews/refreshes cannot undo Stop. Failures identify the clip, unlock/remove failed work, preserve prior receipts, and let other jobs continue. Queues/workspace membership are session-only; orphan cleanup and durable recovery remain deferred.
- Export requires clean selected Library clips and a destination outside the Library; prevent source-file aliases. Keep editor formatting separate from guarded transfers: original stem plus collision-safe fingerprint prefix, matching `Proxy/` files, and cumulative root `_metadata.csv`. Atomically upsert successful rows by exported filename, including blanks, preserving other rows. Read the latest CSV per serial job; preserve/report malformed or changed/linked documents. Do not export app JSON, rewrite originals, or migrate old export folders.
- Delete reviews explicit Library clips with exclusion/restoration. Delete only matching regular flat `<id>.*` files, including derived assets, and clear completed clips' local catalogue/drafts/receipts. Guard mounts, identities, stale reviews, and locks; report incomplete deletions for fresh review. Source-card footage and Exports stay untouched; NAS recycling is server-side.

## UX and verification

Keep confirmations brief: action question, impact, optional useful subtext, affected clips. Blue initiates actions, red confirms destructive actions, grey cancels. Inspector actions are icon-only with accessible labels. Proxy/Commit/Export progress is yellow/blue/green and shows active clip percentages with unfinished counts shared across tabs. Work overlays must preserve base card state, selection, and locks. Show one highest-priority application issue, newest among ties; critical errors block adding clips.

Use `npm run build` for type/build checks and relevant `check:*` scripts from `package.json`; avoid redundant full-suite runs for simple edits. `npm run package:mac` rebuilds the locally signed app; `check:packaged` uses isolated data. Preserve uncommitted user work, source assets, bundled LUT provenance, and existing configuration/data compatibility.
