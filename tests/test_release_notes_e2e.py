"""End-to-end tests for both release-notes generators against a real temporary git repo."""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = {
    "scripts": ROOT / "scripts" / "generate_release_notes.py",
    "action": ROOT / ".github" / "actions" / "release-notes" / "generate.py",
}


def load(name):
    spec = importlib.util.spec_from_file_location(f"release_notes_{name}", SCRIPTS[name])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(params=sorted(SCRIPTS))
def notes(request):
    return load(request.param), request.param


def run(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"})


@pytest.fixture
def repo(tmp_path, monkeypatch):
    run(tmp_path, "init", "-q", "-b", "main")

    def commit(msg, body=""):
        (tmp_path / "f.txt").write_text(msg + body)
        run(tmp_path, "add", "f.txt")
        args = ["commit", "-q", "-m", msg] + (["-m", body] if body else [])
        run(tmp_path, *args)

    commit("chore: initialize")
    run(tmp_path, "tag", "v0.1.0")
    commit("feat(ui): show build version")
    commit("fix: login with mixed-case email")
    commit("refactor!: drop cloudflared")
    commit("perf: faster sync", "BREAKING CHANGE: new env var")
    commit("Update README")
    commit("docs: explain hotpot")
    run(tmp_path, "tag", "v0.2.0-rc.1")
    commit("test: more coverage")
    run(tmp_path, "tag", "v0.2.0")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_previous_tag_and_commits_from_git(repo, notes):
    mod, _ = notes
    assert mod.previous_tag("v0.2.0") == "v0.1.0", "prereleases are skipped"
    assert mod.previous_tag("v0.1.0") is None
    with pytest.raises(ValueError):
        mod.previous_tag("v0.2.0-rc.1")
    subjects = mod.commit_subjects("v0.2.0", "v0.1.0")
    assert [s[1] for s in subjects][:2] == ["test: more coverage", "docs: explain hotpot"]
    assert len(subjects) == 7
    assert any("BREAKING CHANGE" in s[2] for s in subjects)
    assert len(mod.commit_subjects("v0.1.0", None)) == 1


def test_full_notes_from_git(repo, notes):
    mod, _ = notes
    text = mod.render("v0.2.0", "owner/brewcrm", "brewcrm", "ghcr.io/owner/brewcrm")
    assert text.startswith("# brewcrm 0.2.0\n\nChanges since **v0.1.0**.")
    assert text.index("## 💥 Breaking changes") < text.index("## ✨ Features")
    breaking = text.split("## 💥 Breaking changes")[1].split("##")[0]
    assert "drop cloudflared" in breaking and "faster sync" in breaking
    assert "**ui:** show build version" in text
    assert "## 🔧 Other changes" in text and "Update README" in text
    assert "docker pull ghcr.io/owner/brewcrm:0.2.0" in text
    assert "compare/v0.1.0...v0.2.0" in text
    first = mod.render("v0.1.0", "owner/brewcrm", "brewcrm", "img")
    assert "**Source:** https://github.com/owner/brewcrm/tree/v0.1.0" in first
    local = mod.render("v0.2.0", "", "brewcrm", "img")
    assert "https://github.com" not in local


def test_main_writes_the_file(repo, notes, monkeypatch, tmp_path):
    mod, name = notes
    out = tmp_path / "notes.md"
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/brewcrm")
    monkeypatch.setattr(sys, "argv", ["gen", "--tag", "v0.2.0", "--project-name", "brewcrm", "--image", "ghcr.io/owner/brewcrm", "--output", str(out)])
    mod.main()
    assert "# brewcrm 0.2.0" in out.read_text(encoding="utf-8")


def test_action_copy_can_omit_the_image(repo):
    mod = load("action")
    text = mod.render("v0.2.0", "owner/brewcrm", "brewcrm", "")
    assert "## 🐳 Docker" not in text


def test_scripts_run_as_cli(repo, tmp_path):
    for name, path in SCRIPTS.items():
        out = tmp_path / f"{name}.md"
        subprocess.run([sys.executable, str(path), "--tag", "v0.2.0", "--project-name", "p", "--image", "i", "--output", str(out)],
                       cwd=repo, check=True)
        assert out.read_text(encoding="utf-8").startswith("# p 0.2.0")
