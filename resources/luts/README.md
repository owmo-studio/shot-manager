# Optional viewing LUTs

Choose **Shot Manager → Open LUT Folder…** in the macOS menu. Copy your Rec.709 transform into that folder with the matching filename, then reselect the clip. Tables must be unit-domain 3D `.cube` files, up to 65 points per axis. A personal LUT takes precedence over an embedded one.

| Capture profile | Filename | Source |
| --- | --- | --- |
| Sony S-Log3 / S-Gamut3.Cine | `sony-s709.cube` | [Sony Cine s709 V200](https://sony-cinematography.com/resources/luts/) |
| Apple Log / BT.2020 (original Apple Log) | `apple-log-rec709.cube` | Supply your own compatible transform. [Apple Developer Downloads](https://developer.apple.com/download/all/?q=Apple%20Log) |

With no matching table, previews and thumbnails use the original image. LUTs are viewing aids. Proxy encoding and media transfers always use the original colors.

For development, put either table in this directory. To fetch the Sony table from its publisher, run `python3 scripts/setup-luts.py` from the repo root. Pass `--destination "/path/to/LUTs"` to install directly into the folder opened by the app. For Apple, copy in a compatible table you have permission to use.

`npm run package` creates a release without LUTs. `npm run package:with-luts` embeds available tables from this directory for a personal build. Vendor tables retain their own license terms.
