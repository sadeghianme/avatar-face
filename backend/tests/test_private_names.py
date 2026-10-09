"""A module's private names stay in that module.

A name with a leading underscore is the module's own: no other module, a
package's __init__ or a test included, imports it, reads it as
`module._name`, patches it ("pkg.module._name", or setattr(module,
"_name", ...)), or lists it in __all__. What another module needs is
public in the module that owns it; what a package re-exports is public
(services.creations' docstring has the convention). A test reaches a
module through its public names too: the function it drives, or the seam
it patches where the module looks it up.

Checked on the source of the application, its scripts and its tests,
with the AST, for this repository's modules only (a third-party
library's privates are its own business), and for module-level names only
(a class's private members are the class's).
"""

import ast
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
ROOTS = ("app", "scripts", "tests")


def _private(name: str) -> bool:
    return name.startswith("_") and not name.startswith("__") and name != "_"


def _module_of(path: Path) -> str:
    parts = list(path.relative_to(BACKEND).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _sources() -> dict[str, Path]:
    """Every module of the backend, by dotted name."""
    return {
        _module_of(path): path for root in ROOTS for path in sorted((BACKEND / root).rglob("*.py"))
    }


MODULES = _sources()


def _resolve(module: str, is_package: bool, level: int, name: str | None) -> str:
    """The absolute module a (possibly relative) from-import names."""
    if level == 0:
        return name or ""
    base = module.split(".") if is_package else module.split(".")[:-1]
    base = base[: len(base) - (level - 1)]
    return ".".join([*base, name] if name else base)


def _dotted(node: ast.expr) -> list[str] | None:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    return [node.id, *reversed(parts)]


def private_uses(module: str, is_package: bool, source: str) -> list[str]:
    """Each use, in `source` (the module `module`), of another module's
    private name or a private name in __all__, as "line: what"."""
    tree = ast.parse(source)
    bound: dict[str, str] = {}  # a local name -> the module it is
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    bound[alias.asname] = alias.name
                else:
                    head = alias.name.split(".")[0]
                    bound[head] = head
        elif isinstance(node, ast.ImportFrom):
            source_module = _resolve(module, is_package, node.level, node.module)
            for alias in node.names:
                if f"{source_module}.{alias.name}" in MODULES:
                    bound[alias.asname or alias.name] = f"{source_module}.{alias.name}"

    def module_named(node: ast.expr) -> str | None:
        """The repository module `node` evaluates to, if it is one."""
        parts = _dotted(node)
        if parts is None or parts[0] not in bound:
            return None
        name = ".".join([bound[parts[0]], *parts[1:]])
        return name if name in MODULES else None

    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            source_module = _resolve(module, is_package, node.level, node.module)
            for alias in node.names:
                if _private(alias.name) and source_module != module:
                    found.append(f"{node.lineno}: from {source_module} import {alias.name}")
        elif isinstance(node, ast.Attribute) and _private(node.attr):
            owner = module_named(node.value)
            if owner is not None and owner != module:
                found.append(f"{node.lineno}: {owner}.{node.attr}")
        elif isinstance(node, ast.Call):
            # setattr(module, "_name", ...), patch.object, getattr, a spy
            # helper: a module followed by the private name, as a string.
            for target, name in zip(node.args, node.args[1:]):
                if isinstance(name, ast.Constant) and isinstance(name.value, str):
                    owner = module_named(target)
                    if _private(name.value) and owner is not None and owner != module:
                        found.append(f"{node.lineno}: {owner}.{name.value} (by name)")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # A patch target: "app.services.module._name".
            owner, _, name = node.value.rpartition(".")
            if _private(name) and owner in MODULES and owner != module:
                found.append(f"{node.lineno}: {node.value}")
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets
        ):
            for item in getattr(node.value, "elts", []):
                if isinstance(item, ast.Constant) and _private(str(item.value)):
                    found.append(f"{node.lineno}: __all__ lists {item.value}")
    return sorted(found, key=lambda use: int(use.split(":", 1)[0]))


def test_the_check_finds_every_kind_of_use():
    """Each form once, from a module of the tests' own (whose privates are
    a test's), so the check below cannot pass by finding nothing."""
    source = "\n".join(
        (
            "from app.services import matting",
            "from app.services.matting import _hidden",
            "from app.services import photo_adjust as pa",
            "matting._hidden(1)",
            "pa.paste._hidden",
            "setattr(matting, '_hidden', None)",
            "patch('app.services.matting._hidden')",
            "__all__ = ['_hidden', 'public']",
            "matting.box_mean, pa.paste.hull_mask, _own",
        )
    )
    assert private_uses("tests.test_private_names", False, source) == [
        "2: from app.services.matting import _hidden",
        "4: app.services.matting._hidden",
        "5: app.services.photo_adjust.paste._hidden",
        "6: app.services.matting._hidden (by name)",
        "7: app.services.matting._hidden",
        "8: __all__ lists _hidden",
    ]


def test_a_module_may_use_its_own_private_names():
    source = "import app.services.matting as me\nme._hidden\n__all__ = ['box_mean']\n"
    assert private_uses("app.services.matting", False, source) == []


def test_no_module_uses_another_modules_private_names():
    found = []
    for module, path in MODULES.items():
        for use in private_uses(module, path.name == "__init__.py", path.read_text()):
            found.append(f"{path.relative_to(BACKEND)}:{use}")
    assert found == []
