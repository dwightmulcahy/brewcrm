import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("edition", ["web", "offline"])
def test_build_edition(tmp_path, edition):
    out = tmp_path / edition
    subprocess.run(
        ["node", "scripts/build.mjs", edition],
        cwd=ROOT, env={**os.environ, "OUT_DIR": str(out)}, check=True,
    )
    assert (out / "index.html").is_file()
    assert json.loads((out / "build.json").read_text())["edition"] == edition


def test_build_rejects_unknown_edition():
    r = subprocess.run(["node", "scripts/build.mjs", "bogus"], cwd=ROOT, capture_output=True)
    assert r.returncode != 0
