"""Run via uv with a Python version matching Blender's embedded Python."""
import os
import site
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
environment = dict(os.environ)
environment["PYTHONHOME"] = sys.base_prefix
environment["PYTHONPATH"] = os.pathsep.join(site.getsitepackages())
subprocess.run([
    "blender", "--background", "--factory-startup", "--disable-autoexec",
    "--python-use-system-env", "--python-exit-code", "1",
    "--python", str(root / "scripts" / "build-aircraft.py"),
], cwd=root, env=environment, check=True)
for name in ("kestrel.glb", "practice-bomb.glb"):
    if not (root / "public" / "assets" / name).is_file():
        raise RuntimeError(f"Blender did not generate {name}")
