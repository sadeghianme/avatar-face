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


# What may still be imported inside a function: heavy or optional runtimes,
# loaded on first use so that a server without them (the [rig] or [clone]
# extra, the Azure SDK) starts, and one with them starts fast.
LAZY = ("mediapipe", "cv2", "torch", "chatterbox", "kokoro_onnx", "soundfile", "piper", "azure")


def test_imports_are_at_module_level_except_heavy_optional_runtimes():
    """An import inside a function hides a dependency, and usually an
    import cycle. Everything else is imported where a reader looks."""

    def local(node: ast.AST, in_function: bool, path: Path) -> list[str]:
        found = []
        for child in ast.iter_child_nodes(node):
            if in_function and isinstance(child, (ast.Import, ast.ImportFrom)):
                module = child.module if isinstance(child, ast.ImportFrom) else child.names[0].name
                if not (module or "").startswith(LAZY):
                    found.append(f"{path.relative_to(APP.parent)}:{child.lineno} imports {module}")
            found += local(
                child,
                in_function or isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)),
                path,
            )
        return found

    hidden = []
    for path in sorted(APP.rglob("*.py")):
        hidden += local(ast.parse(path.read_text()), False, path)
    assert hidden == []


def _module_graph() -> dict[str, set[str]]:
    """Which modules each module needs loaded to run its top level.

    A from-import of names needs that module (for a package, its __init__)
    to have run that far; a submodule needs its package to exist, which it
    already does inside the package itself.
    """
    modules = {}
    for path in sorted(APP.rglob("*.py")):
        parts = list(path.relative_to(APP.parent).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        modules[".".join(parts)] = path

    def parents(name: str) -> list[str]:
        parts = name.split(".")
        return [".".join(parts[:i]) for i in range(2, len(parts))]

    graph: dict[str, set[str]] = {}
    for name, path in modules.items():
        inside = set(parents(name)) | ({name} if path.name == "__init__.py" else set())
        needs: set[str] = set()
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    needs |= {*parents(alias.name), alias.name}
            elif isinstance(node, ast.ImportFrom) and node.module:
                needs |= {p for p in parents(node.module) if p not in inside}
                names = [a.name for a in node.names if f"{node.module}.{a.name}" not in modules]
                needs |= {f"{node.module}.{a.name}" for a in node.names} & modules.keys()
                if names or node.module not in inside:
                    needs.add(node.module)
        graph[name] = {n for n in needs if n in modules and n != name}
    return graph


def test_no_module_level_import_cycles():
    """Each module can be the first one imported: nothing it needs at load
    time needs it back."""
    graph = _module_graph()
    cycles = []
    state: dict[str, int] = {}  # 1: on the current path, 2: done

    def visit(name: str, path: list[str]) -> None:
        state[name] = 1
        for dep in sorted(graph[name]):
            if state.get(dep) == 1:
                cycles.append(" -> ".join(path[path.index(dep):] + [dep]))
            elif dep not in state:
                visit(dep, [*path, dep])
        state[name] = 2

    for name in sorted(graph):
        if name not in state:
            visit(name, [name])
    assert cycles == []
