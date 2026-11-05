import pathlib
import re

ROOT = pathlib.Path(__file__).parents[1]
HOOKS = ROOT / "pb_hooks"

# Overrides used only to point integrations at mocks in tests
TEST_ONLY_ENV = {"PLACES_BASE_URL", "GMAIL_BASE_URL", "GOOGLE_TOKEN_URL", "LOYVERSE_BASE_URL"}


def _hook_env_vars():
    names = set()
    for path in HOOKS.rglob("*.js"):
        names |= set(re.findall(r'env\("([A-Z0-9_]+)"', path.read_text(encoding="utf-8")))
    return names


def test_every_runtime_env_var_is_documented():
    documented = set(re.findall(r"^([A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M))
    missing = _hook_env_vars() - TEST_ONLY_ENV - documented
    assert not missing, f"document in .env.example: {sorted(missing)}"


def test_entrypoint_env_vars_are_documented():
    documented = set(re.findall(r"^([A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M))
    used = set(re.findall(r"\$\{([A-Z0-9_]+):-", (ROOT / "docker-entrypoint.sh").read_text()))
    assert used - {"DATA_DIR", "PORT"} <= documented


def test_dockerfile_pb_version_matches_offline_docs():
    version = re.search(r"^ARG PB_VERSION=(\S+)", (ROOT / "Dockerfile").read_text(), re.M).group(1)
    assert re.fullmatch(r"\d+\.\d+\.\d+", version)


def test_public_signup_is_disabled_in_schema():
    migration = next((ROOT / "pb_migrations").glob("*_init_crm.js")).read_text()
    assert "users.createRule = null" in migration


def test_crm_routes_require_auth_except_public_ones():
    src = (HOOKS / "crm.pb.js").read_text()
    blocks = re.split(r"\nrouterAdd\(", src)[1:]
    for block in blocks:
        path = re.match(r'"[A-Z]+",\s*"([^"]+)"', block).group(1)
        handler_end = block.index("\n}")
        tail = block[handler_end:handler_end + 40]
        if path in {"/health", "/api/crm/google/callback", "/api/crm/public-config"}:
            continue
        assert "$apis.requireAuth()" in tail, f"{path} must require auth"


def test_kv_collection_has_no_api_rules():
    migration = next((ROOT / "pb_migrations").glob("*_init_crm.js")).read_text()
    kv = migration.split("const kv = new Collection(", 1)[1].split("app.save(kv)", 1)[0]
    assert "crmRules" not in kv and "Rule" not in kv


def test_compose_files_have_no_cloudflared():
    for name in ("compose.yaml", "compose.qnap.yaml"):
        text = (ROOT / name).read_text()
        assert "cloudflared" not in text and "TUNNEL_TOKEN" not in text, name


def test_qnap_container_name_is_stable_for_logwatch_and_hotpot():
    assert "container_name: brewcrm" in (ROOT / "compose.qnap.yaml").read_text()


def test_hooks_log_only_through_the_json_writer():
    # logwatch flags every non-JSON stdout line; console.log adds a timestamp prefix
    offenders = []
    for path in HOOKS.rglob("*.js"):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("//", 1)[0]
            if "console.log(" in code and "else console.log(json)" not in code:
                offenders.append(f"{path.relative_to(ROOT)}:{n}")
    assert not offenders, f"use crm.log(level, message, detail) instead: {offenders}"


def test_crm_routes_block_temporary_passwords():
    src = (HOOKS / "crm.pb.js").read_text()
    for block in re.split(r"\nrouterAdd\(", src)[1:]:
        path = re.match(r'"[A-Z]+",\s*"([^"]+)"', block).group(1)
        if path.startswith("/api/crm/") and path not in {"/api/crm/status", "/api/crm/public-config", "/api/crm/google/callback"}:
            assert "crm.requireActive(e)" in block.split("\n});", 1)[0] + block.split("\n}, $apis", 1)[0], path


def test_crm_collection_rules_require_a_changed_password():
    migration = (ROOT / "pb_migrations" / "1730800000_password_policy.js").read_text()
    assert "@request.auth.must_change_password = false" in migration
    for name in ("accounts", "contacts", "deals", "touches", "leads"):
        assert f'"{name}"' in migration


def test_env_example_admin_password_meets_policy():
    pw = re.search(r"^PB_ADMIN_PASSWORD=(.*)$", (ROOT / ".env.example").read_text(), re.M).group(1)
    assert len(pw) >= 12 and re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw)
    assert len(pw) >= 16 or re.search(r"[^A-Za-z0-9\s]", pw)
