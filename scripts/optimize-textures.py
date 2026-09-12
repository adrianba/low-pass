# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow>=11,<13"]
# ///
"""uv run scripts/optimize-textures.py path/to/Ground037.zip path/to/Rock030.zip"""
import sys
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile
from PIL import Image

out = Path(__file__).resolve().parent.parent / "public" / "assets" / "terrain"
if len(sys.argv) != 3:
    raise SystemExit("Supply the original Ground037 and Rock030 1K-JPG archive paths.")
for asset, archive in zip(("Ground037", "Rock030"), sys.argv[1:]):
    with ZipFile(archive) as source:
        for channel in ("Color", "NormalGL", "Roughness"):
            name = f"{asset}_1K-JPG_{channel}.jpg"
            image = Image.open(BytesIO(source.read(name))).convert("RGB")
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            encoded = BytesIO()
            image.save(encoded, "JPEG", quality=90, subsampling=0)
            (out / name).write_bytes(encoded.getvalue())
            print(name, image.size, (out / name).stat().st_size, "bytes")
