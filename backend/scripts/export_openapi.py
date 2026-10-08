"""Write the API's OpenAPI document to a file, the same bytes every time.

The one generator of frontend/src/lib/api-schema.json, the committed
contract: the dashboard generates its TypeScript types from it
(openapi-typescript, `npm run gen:api`) and so does the widget
(embed/scripts/gen-api-types.mjs). The file has to change when the API does
and only then: keys are sorted, indentation and the trailing newline are
fixed, and nothing is read from a running server, the database or the
network.

    python -m scripts.export_openapi                # the committed file, from backend/
    python scripts/export_openapi.py openapi.json   # anywhere else, from anywhere
    python -m scripts.export_openapi -              # to stdout

CI's backend-checks job exports it again and fails on any difference, so the
committed document is always the code's (docs/process.md, "CI").
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
COMMITTED = BACKEND.parent / "frontend" / "src" / "lib" / "api-schema.json"
# This checkout's `app`, whatever else the interpreter has installed.
if str(BACKEND) not in sys.path[:1]:
    sys.path.insert(0, str(BACKEND))


def openapi_document() -> dict[str, Any]:
    """The schema FastAPI serves at /openapi.json, built without serving."""
    from app.main import create_app

    return create_app().openapi()


def render(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "output",
        nargs="?",
        default=str(COMMITTED),
        help="where to write the JSON, or - for stdout (default: the committed document)",
    )
    args = parser.parse_args(argv)
    text = render(openapi_document())
    if args.output == "-":
        sys.stdout.write(text)
    else:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
