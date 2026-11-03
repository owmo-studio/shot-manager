"""Install local viewing tables; originals and NAS media are never accessed."""
from pathlib import Path
import hashlib
import io
import struct
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent / 'resources' / 'luts'
root.mkdir(parents=True, exist_ok=True)
url = 'https://77snszqv.media.zestyio.com/Slog3-S-Gamut3.Cine_To_s709_V200.zip'
if not (root / 'sony-s709.cube').exists():
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read(10 * 1024 * 1024)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        sony = bundle.read('Slog3-S-Gamut3.Cine_To_s709_V200.cube')
    (root / 'sony-s709.cube').write_bytes(sony)

# Apple's local Helium resource is a red-fastest 65^3 big-endian RGB16 table.
# Keep the original fingerprint alongside the converted local-use .cube.
apple = Path('/Applications/iMovie.app/Contents/Frameworks/Helium.framework/Versions/A/Resources/AppleLogToRec709_v1.0.3dlut')
if not (root / 'apple-log-rec709.cube').exists():
    data = apple.read_bytes()
    if len(data) != 65 ** 3 * 6:
        raise ValueError('Unrecognized Apple LUT resource. Supply an official Apple Log .cube instead.')
    values = list(struct.iter_unpack('>3H', data))
    if values[0] != (0, 0, 0) or values[64] != (65535, 0, 0) or values[64 * 65] != (0, 65535, 0):
        raise ValueError('Unrecognized Apple LUT ordering.')
    header = '# Converted locally from Apple iMovie Helium AppleLogToRec709_v1.0.3dlut\nLUT_3D_SIZE 65\n'
    (root / 'apple-log-rec709.cube').write_text(header + ''.join(' '.join(f'{v / 65535:.8f}' for v in row) + '\n' for row in values))
    (root / 'apple-resource.sha256').write_text(hashlib.sha256(data).hexdigest() + '\n')
print('Local Sony and Apple viewing LUTs are ready.')
