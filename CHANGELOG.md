# Changelog

## 1.3.0 - 2026-11-25

### Added

- **Advanced → Re-Encode Proxies** regenerates proxies for selected Library clips. Review the selection, encode from the Library originals into the local cache, then choose **Commit** to replace the published proxies or **Revert** to discard the replacements.

### Changed

- DaVinci Resolve exports include `Start TC` and `End TC` when source timing is available, so clips can match with Resolve’s default metadata import settings. Re-exporting preserves existing CSV rows.
- **Open Resources Folder** and **Clean Orphaned Data** are now in the **Advanced** menu.

### Fixed

- Newly encoded proxies preserve source timecode and drop-frame counting, including embedded Sony camera timecode.
- Proxy encoding preserves source color levels, gamut, and gamma more accurately, including Sony S-Log3 and Apple Log footage.

## 1.2.0 - 2026-11-24

### Changed

- Export uses the full clip fingerprint for source and proxy filenames. The DaVinci Resolve CSV matches the exported filenames and keeps the original camera filename stem in `Clip Name`.
- Re-exporting to a folder from an earlier version preserves its existing media and CSV rows.

## 1.1.0 - 2026-11-23

### Added

- **Clean Orphaned Data...** in the Shot Manager menu. Review files left by incomplete Commits, keep individual files, and confirm deletion of the rest.

## 1.0.0 - 2026-11-23

- First release of Shot Manager for macOS.
