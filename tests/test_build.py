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
    assert (out / "pb_public" / "index.html").is_file()
    assert (out / "pb_hooks" / "crm.pb.js").is_file()
    assert (out / "pb_hooks" / "lib" / "crm.js").is_file()
    assert any((out / "pb_migrations").glob("*.js"))
    meta = json.loads((out / "build.json").read_text())
    assert meta["edition"] == edition
    assert meta["pocketbase"]
    if edition == "offline":
        assert (out / "start.sh").is_file()
        assert os.access(out / "start.sh", os.X_OK)
        assert (out / "start.cmd").is_file()
        assert meta["pocketbase"] in (out / "OFFLINE.md").read_text()
    else:
        assert not (out / "start.sh").exists()


def test_build_rejects_unknown_edition():
    r = subprocess.run(["node", "scripts/build.mjs", "bogus"], cwd=ROOT, capture_output=True)
    assert r.returncode != 0
