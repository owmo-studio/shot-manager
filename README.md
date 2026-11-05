# OWMO Shot Manager

OWMO Shot Manager is a local macOS desktop app for browsing original video footage from cards and folders, inspecting clips, and assigning optional per-shot metadata. The planned Import workflow will ingest footage into a canonical NAS Library. **Ingestion is not implemented yet.**

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

- Add multiple card or folder sources, browse original videos by recording date, filter by source/device, inspect technical metadata, and play or seek the original video. Previews are generated locally; camera proxies, thumbnails, and external XML are not used.
- Edit optional Identity, Project, Context tags, and Notes per clip. Metadata drafts persist locally; source lists, editing selections, and skip choices last only for the current session. Skipping a clip is separate from selecting it for inspection.
- Use the inspector's LUT toggle to review supported Sony S-Log3 and Apple Log footage. Viewing transforms and cached previews do not change source files.
- Set a Library location in Configuration. This only saves a path; it does not scan or write to the Library. **Review & Ingest remains disabled.**

Configuration's **Reset Local Data** requires confirmation and deletes local clip drafts, saved Identity/Project/Tag lists, fingerprints, previews, sources, selections, and skip choices. It preserves app configuration, LUTs, source footage, and Library files. Sources must be added again afterward. Removing a saved option or clearing selected clips' metadata is a narrower operation.

Removing Identity, Project, or Context entries in Configuration also removes those values from all saved local clip records. **Save** shows an affected-clip count and scrollable table before confirmation; unused entries are deleted directly. No rescan is triggered. Other metadata stays intact. Removal waits for active scans to finish; changed metadata requires a fresh review. Older saved records without a filename show a clip identifier until scanned again.

## Development

The app uses Electron and React in `desktop/` and `client/`, a local Fastify backend in `server/`, and shared types in `shared/`. The renderer accesses files through restricted preload/backend interfaces. The backend runs in a separate Electron utility process.

```sh
npm run typecheck
npm run check:configuration
npm run check:organization
npm run check:selection
npm run check:quit
```

The checks use temporary fixtures. Develop ingestion against dummy folders only; real NAS access requires explicit authorization and mounted-volume validation. See [AGENTS.md](AGENTS.md) for project safety and implementation constraints.
