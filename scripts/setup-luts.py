"""Fetch Sony's s709 V200 for an optional local installation."""
import argparse
import hashlib
import io
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
import urllib.request
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--destination', type=Path,
                    default=Path(__file__).resolve().parents[1] / 'resources' / 'luts')
folder = parser.parse_args().destination.expanduser()
target = folder / 'sony-s709.cube'
if target.exists():
    print(f'Already installed: {target}')
else:
    url = 'https://77snszqv.media.zestyio.com/Slog3-S-Gamut3.Cine_To_s709_V200.zip'
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError('Sony archive exceeds the expected size.')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entry = archive.getinfo('Slog3-S-Gamut3.Cine_To_s709_V200.cube')
        if entry.file_size > 2 * 1024 * 1024:
            raise ValueError('Unexpected Sony table size.')
        table = archive.read(entry)
    if hashlib.sha256(table).hexdigest() != '79f33e0dba22f5e2e9710ef58c6ca3d331304a6dc2b66b5ed5047145acc37a4d':
        raise ValueError('Sony download differs from the expected s709 V200 table.')
    folder.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=folder) as temporary:
        temporary.write(table)
        temporary.flush()
        os.link(temporary.name, target)
    print(f'Installed: {target}')
