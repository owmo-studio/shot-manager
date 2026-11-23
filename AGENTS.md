# Shot Manager

Shot Manager is a single-user macOS Electron app for importing footage, committing it to a Library, and exporting it for editing. See the [README](README.md) for requirements, setup, and usage.

## Working in the repo

- `client/src/` contains the React interface. `desktop/` owns the Electron window, preload bridge, native pickers, and edit-save handling.
- `server/` contains the Fastify backend, media inspection, and workers. Start with `workspace.ts` for Import membership, `catalogue.ts` for the Library view, `ingestion.ts` for Commit, and `sync.ts` for Export.
- `shared/` defines the TypeScript contracts used across processes. Follow the conventions in adjacent code and preserve compatibility with existing Library files, settings, and drafts.
- Keep changes focused. Discuss new services, databases, Resolve integrations, or expanded search before introducing them. Keep vendor LUTs out of Git and all packages. See the [resource guide](resources/README.md).

## Checks

Run `npm ci` after cloning. Choose checks that exercise the change.

| Command | Use |
| --- | --- |
| `npm run build` | Type-check and build the application |
| `npm test -- catalogue` | Run one test by filename stem from `tests/`. Use `npm test` for the full non-UI suite |
| `npm run test:ui -- selection` | Build and run one Electron test from `tests/ui/`. Omit the name for all UI tests |
| `npm run package` then `npm run test:packaged` | Verify packaging changes against the built app using an isolated profile |

## Media and filesystem safety

- Use synthetic footage and temporary profiles, Libraries, and export folders in tests. Access to real NAS media requires explicit permission, even when the app already has a Library configured. Original footage is read-only.
- Before writing or deleting, revalidate the mounted volume, directory identity, and reviewed files. A disconnected SMB share can leave an ordinary local directory at the same path. Preserve symlink and alias checks. Distinct nested directories are valid where configuration permits them.
- Keep filesystem routes identifier-based, destination selection behind native pickers, and the backend on authenticated loopback. Report unknown mutation outcomes and never automatically retry a non-idempotent submission.
- Destructive actions require confirmation. Library Delete acts only on reviewed regular files belonging to the clip. Never recursively delete a Library folder. Preserve and report corrupt local state.

## Contracts worth preserving

- Use each original’s embedded metadata for device recognition. Preserve unknown or conflicting values. The sampled fingerprint identifies a clip across locations. Keep the captured source path fixed for queued work.
- The Library is flat. Preserve original filenames in JSON, optional fields including blanks, and the persisted `rating` key for Quality. Accept successful rsync completion. Publish metadata atomically after media transfers, then persist the receipt before removing the cached proxy.
- Keep the catalogue separate from fingerprint-keyed local drafts. An unavailable Library is unverified. Refresh and Library Delete preserve local edits. Revert restores attributes and thumbnail together. Only Clear Cache and retention remove drafts.
- The backend owns session queues across renderer reloads. Proxy, Commit, and Export workers run independently with per-clip locks and immutable reviewed inputs. Preserve completed publications when cancellation races completion. Quit drains accepted edits and surfaces save failures.
- Commit respects the current filtered selection and Skip. Export requires clean selected Library clips and a separate destination. Keep Resolve naming and CSV formatting separate from the guarded file transfers. Update `_metadata.csv` atomically after successful exports, preserving other rows.
