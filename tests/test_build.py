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
    public = json.loads((out / "pb_public" / "version.json").read_text())
    assert public == {"version": meta["version"], "commit": meta["commit"]}
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


def _build_version(tmp_path, **env):
    out = tmp_path / "v"
    clean = {k: v for k, v in os.environ.items() if k not in ("APP_VERSION", "GIT_SHA")}
    subprocess.run(["node", "scripts/build.mjs", "web"], cwd=ROOT,
                   env={**clean, "OUT_DIR": str(out), **env}, check=True, capture_output=True)
    return json.loads((out / "pb_public" / "version.json").read_text())


@pytest.mark.parametrize(
    "env, expected",
    [
        ({}, {"version": "dev", "commit": ""}),
        ({"APP_VERSION": "1.4.2", "GIT_SHA": "ABCDEF0123456789"}, {"version": "1.4.2", "commit": "abcdef0"}),
        ({"APP_VERSION": "v2.0.0-rc.1"}, {"version": "2.0.0-rc.1", "commit": ""}),
        ({"APP_VERSION": "<script>", "GIT_SHA": "not-a-sha"}, {"version": "dev", "commit": ""}),
    ],
)
def test_version_json(tmp_path, env, expected):
    assert _build_version(tmp_path, **env) == expected


def test_changelog_placeholder_or_bundled_notes(tmp_path):
    out = tmp_path / "c"

    def run():
        subprocess.run(["node", "scripts/build.mjs", "web"], cwd=ROOT,
                       env={**os.environ, "OUT_DIR": str(out), "APP_VERSION": "3.1.0"},
                       check=True, capture_output=True)

    src = ROOT / "pb_public" / "changelog.json"
    assert not src.exists(), "generated at release time only"
    run()
    data = json.loads((out / "pb_public" / "changelog.json").read_text())
    assert data == {"current": "3.1.0", "repository": "dwightmulcahy/brewcrm", "releases": []}
    try:
        src.write_text('{"current": "3.1.0", "releases": [{"version": "3.1.0"}]}')
        run()
        assert json.loads((out / "pb_public" / "changelog.json").read_text())["releases"] == [{"version": "3.1.0"}]
    finally:
        src.unlink()
    html = (out / "pb_public" / "index.html").read_text()
    assert 'src="whats-new.js" data-src="changelog.json"' in html and "data-whats-new" in html
