# Shot Manager

Shot Manager is a macOS app for organizing footage in a local or NAS Library and exporting selected clips for editing.

`This project is developed using OpenAI Codex; use it at your own risk!`

## Requirements

- To run Shot Manager: macOS, FFmpeg, and FFprobe. Proxy encoding requires the `prores_ks` encoder and the scale filter’s `reset_sar` option.
- To develop or package the app: Node.js 22.12 or later with npm.

After cloning the repository, run `npm ci` to install its dependencies.

## Development

`npm run dev`

## Package

`npm run package`

## Install

Move `Shot Manager.app` from `release/mac-arm64/` (Apple Silicon) or `release/mac/` (Intel) into Applications.

## Usage

### Import & Commit media

1. In **Configuration**, choose a Library folder on a local drive or mounted NAS and click **Save**.
2. In **Import**, drop video files or folders and add any metadata you want. Shot Manager prepares thumbnails and editing proxies in its local cache.
3. Select clips and click **Commit**. With no selection, Commit reviews all eligible clips in the current view. **Skip** excludes a clip.

Commit copies the full-resolution video as-is and leaves the original in place. Each clip gets a sampled SHA-256 fingerprint (`<id>`) that ties together four files in the Library folder:

```text
<id>.source.<ext>     Original video in its recorded format
<id>.proxy.mov        ProRes 422 Proxy, up to 1280 pixels on the long edge
<id>.thumb.jpg        Selected thumbnail
<id>.metadata.json    Original filename, technical details, and your clip attributes
```

Shot Manager writes the JSON after the media transfers succeed. The committed clip then leaves Import and appears in Library.

### Camera recognition

Shot Manager reads device information embedded in each original. Import scans MP4, MOV, MXF, M4V, MTS, M2TS, AVI, MKV, and WebM files.

- Sony FX30
- Sony ZV-E10 II
- Apple iPhone

Optional Sony S-Log3 and Apple Log viewing LUTs apply to previews and thumbnails. To install one, choose **Shot Manager → Open Resources Folder…** in the macOS menu bar, copy the file into `LUT/`, then reselect the clip. [Supported LUTs and required filenames](resources/README.md)

### Export

Export copies selected Library clips to your destination folder, with matching proxies in `Proxy/`. It also writes clip metadata to `_metadata.csv`, formatted for import into DaVinci Resolve.
