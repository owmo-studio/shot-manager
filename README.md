# OWMO Shot Manager

A single-user macOS app for reviewing footage, editing clip metadata, committing media to a NAS Library, and exporting selected clips for DaVinci Resolve.

## Run and build

Development requires macOS, Node.js 22.12+, and npm. FFmpeg/FFprobe must be installed locally, with ProRes encoding and the scale filter's `reset_sar` option. Finder launches support the standard Homebrew paths. Transfers use macOS `/usr/bin/rsync`.

```sh
npm ci                   # Install dependencies
npm run dev              # Development app
npm run package:mac      # Build the .app for this Mac
```

Copy `release/mac-arm64/OWMO Shot Manager.app` to Applications, replacing the previous copy after quitting it. Intel builds use `release/mac/`. The app includes its runtime, dependencies, icon, and [viewing LUTs](resources/luts/README.md); Node/npm are only needed for development. The version beside the title comes from `package.json`.

`npm run build` produces `out/`; `npm start` opens that build. Generated `out/` and `release/` files are excluded from Git.

## Workflow

- **Import:** add folders or drop video files. Edit optional attributes and thumbnails; Skip excludes a clip without removing it. Commit uses selected clips, or all eligible clips when nothing is selected. Completed clips leave Import and appear in Library. Reviewed Synced rows only remove workspace cards.
- **Library:** browse the local catalogue, refresh remote metadata, and stage edits locally. Commit publishes changes; Revert restores Library attributes and thumbnails. Export requires an explicit selection with no pending edits and opens a destination picker before review.
- **Delete:** review selected Library clips, excluding/restoring rows as needed. Confirmation removes associated Library files and local metadata. Original source-card files and prior Exports are kept; any recycle behavior belongs to the NAS.
- **Work:** proxy encoding, Commits, and Exports run independently. The toolbar Stop clears those queues; thumbnails continue. Refresh resumes preparation; cancelled transfers need another submission. Queues and workspace membership are session-only, while drafts and successful Commit receipts persist.

## Storage

The Library is flat, keyed by the full sampled fingerprint:

```text
<id>.source.<original-extension>
<id>.proxy.mov
<id>.thumb.jpg
<id>.metadata.json
```

JSON retains the original filename, technical evidence, and every optional attribute. Source/thumbnail/missing-proxy transfers finish before JSON is published atomically. Existing regular Library proxies are reused. Proxies use ProRes 422 Proxy MOV, 10-bit 4:2:2, a maximum 1280-pixel long edge without upscaling, preserved display aspect ratio, frame timing, timecode, and audio channels. Viewing LUTs are not baked in.

The app manages local data under `Shot Manager Cache` beside Electron's own cache. **Browse Cache** opens it; **Clear Cache** selectively removes app-owned categories without changing Library settings or media. Unused clip data expires after 90 days at graceful shutdown; saved Identity/Project options and corrupt records are preserved. Library catalogue data and pending edits are separate, so refreshing does not discard drafts or the last usable offline view.

Exports contain sources directly in the selected destination, matching files in `Proxy/`, and one `_metadata.csv`. Filenames combine the original stem with a fingerprint prefix. Each successful export adds or replaces its CSV row by filename, preserving other rows and blank fields. Failed/cancelled clips leave previous rows unchanged. Older export folders/CSVs are left untouched.

## Resolve metadata

Import exported source footage; Resolve can discover matching proxies in `Proxy/`. Create **Identity, Project, Group, Camera, and Quality** as Text Input fields under **Manage Custom Metadata → User** for reuse across projects.

Use **File → Import Metadata To → Media Pool**, choose `_metadata.csv`, match filenames, and disable start/end timecode matching. With custom fields defined, disable “Import additional metadata fields as custom metadata” to avoid duplicates. “Update all metadata fields available in source file” applies exported blanks too.

Scene maps to Description, Group to Scene, Camera to Camera #, Notes to Comments, and Preferred/Usable to Good Take. Custom columns retain the assigned values; Clip Name and Keywords provide descriptive/searchable context. All attributes are optional.

## Development

`desktop/` owns Electron/preload and save/quit handling; `client/` is React; `server/` owns discovery, jobs, Library/catalogue, and exports; `shared/` defines contracts. Quality is stored as `rating` for compatibility.

Run `npm run typecheck` or `npm run build`, then the relevant `check:*` scripts listed in `package.json`. `npm run check:packaged` checks shipped files with an isolated profile and synthetic footage. Tests must use temporary sources/destinations, never real cards or NAS media. See [AGENTS.md](AGENTS.md) for engineering constraints.
