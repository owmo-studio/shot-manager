Local viewing LUTs
=================

Run `python3 scripts/setup-luts.py` once. It downloads Sony's official
S-Log3/S-Gamut3.Cine → s709 V2 table from
https://sony-cinematography.com/resources/luts/ and converts the Apple Log →
Rec.709 table from the installed iMovie Helium framework into a local `.cube`.
The Apple resource must be `AppleLogToRec709_v1.0.3dlut`, not Apple Log 2.
Its RGB16 grid layout, length, and primary corner ordering are checked before
conversion; this conversion is our implementation, not an Apple-provided .cube
download. If iMovie is absent, provide an official original Apple Log transform
as `apple-log-rec709.cube` (unit domain, up to 65³ entries).

Tables remain local and gitignored. They are read from this directory in both
development and `npm start`; distribution/packaging and redistribution rights
remain future work. No LUT is downloaded at application startup. Missing or
invalid tables produce a visible preview message and do not modify originals.

Supported automatic transforms are explicitly declared S-Log3/S-Gamut3.Cine
and Apple Log/BT.2020. Rec.709 passes through. Unknown gamuts, other log curves,
HLG, and PQ are not guessed or silently mapped through an unrelated LUT.
This is a viewing aid, not a calibrated grading/export pipeline.
