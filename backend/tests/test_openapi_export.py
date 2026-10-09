"""scripts/export_openapi.py: the contract the frontend generates types from."""

import json
import subprocess
import sys
from pathlib import Path

from scripts import export_openapi

BACKEND = Path(__file__).resolve().parents[1]


def test_it_writes_the_apps_schema_with_sorted_keys(tmp_path):
    out = tmp_path / "nested" / "openapi.json"
    assert export_openapi.main([str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    document = json.loads(text)
    assert document["openapi"].startswith("3.")
    assert "/embed/v1/cues" in document["paths"]
    assert "/auth/login" in document["paths"]
    # Sorted, indented, newline-terminated: re-rendering changes nothing.
    assert text == json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def test_two_exports_are_byte_identical(tmp_path):
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    export_openapi.main([str(first)])
    export_openapi.main([str(second)])
    assert first.read_bytes() == second.read_bytes()


def test_it_runs_as_a_script_from_anywhere(tmp_path):
    """Run by path from another directory, it still finds this checkout's app."""
    result = subprocess.run(
        [sys.executable, str(BACKEND / "scripts" / "export_openapi.py"), "-"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
        timeout=120,
    )
    assert json.loads(result.stdout)["paths"]["/embed/v1/cues"]["post"]


def test_the_committed_document_is_the_codes(tmp_path):
    """frontend/src/lib/api-schema.json, which the dashboard and the widget
    generate their types from, is what this code exports (CI's backend-checks
    job checks the same). Re-export it with `python -m scripts.export_openapi`."""
    out = tmp_path / "openapi.json"
    export_openapi.main([str(out)])
    assert out.read_bytes() == export_openapi.COMMITTED.read_bytes(), (
        "the committed OpenAPI document is stale: run python -m scripts.export_openapi"
    )
