"""The layers import downward only.

    api -> services -> models, schemas, core

Checked on the source, every import statement included (one inside a
function is still a dependency, only a hidden one), so a model that reaches
up into a service fails here rather than as an import cycle later.
"""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"


def _imports(package: str) -> list[tuple[str, int, str]]:
    found = []
    for path in sorted((APP / package).rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.module:
                found.append((str(path.relative_to(APP.parent)), node.lineno, node.module))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    found.append((str(path.relative_to(APP.parent)), node.lineno, alias.name))
    return found


def _reaching(package: str, *upper: str) -> list[str]:
    return [
        f"{path}:{line} imports {module}"
        for path, line, module in _imports(package)
        if module.startswith(upper)
    ]


def test_models_know_nothing_of_services_or_the_api():
    assert _reaching("models", "app.services", "app.api") == []


def test_schemas_know_nothing_of_services_or_the_api():
    assert _reaching("schemas", "app.services", "app.api") == []


def test_core_knows_nothing_of_services_or_the_api():
    # (core.credentials reads its table through app.models: a store, not a
    # service.)
    assert _reaching("core", "app.services", "app.api") == []


def test_services_know_nothing_of_the_api():
    assert _reaching("services", "app.api") == []
