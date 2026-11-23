# Application resources

Every build includes the app icon. Camera LUTs are optional and sourced separately under their vendors’ licenses.

| Capture profile | Required filename | Source |
| --- | --- | --- |
| Sony S-Log3 / S-Gamut3.Cine | `sony-s709.cube` | [Sony Cine s709 V200](https://sony-cinematography.com/resources/luts/) |
| Apple Log / BT.2020 (original Apple Log) | `apple-log-rec709.cube` | [Apple Developer Downloads](https://developer.apple.com/download/all/?q=Apple%20Log) |

**Installed app.** In the macOS menu bar, choose **Shot Manager → Open Resources Folder…**. Copy the file into `LUT/` using the filename above, then reselect the clip. Use a 3D `.cube` table with a 0–1 input range and up to 65 points per axis.

**Development.** `npm run dev` reads LUTs from `resources/luts/` in the checkout. Run `python3 scripts/setup-resources.py` to fetch the Sony LUT there, or copy the Apple LUT there manually. Packaged apps always use the user-installed files.
