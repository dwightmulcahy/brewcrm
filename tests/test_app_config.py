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


def test_crm_routes_require_auth_except_health_and_oauth_callback():
    src = (HOOKS / "crm.pb.js").read_text()
    blocks = re.split(r"\nrouterAdd\(", src)[1:]
    for block in blocks:
        path = re.match(r'"[A-Z]+",\s*"([^"]+)"', block).group(1)
        handler_end = block.index("\n}")
        tail = block[handler_end:handler_end + 40]
        if path in {"/health", "/api/crm/google/callback"}:
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
