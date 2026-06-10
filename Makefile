# Liveface monorepo tasks. Each target cd's into the right package.

.PHONY: up down migrate backend frontend embed test typecheck

# Start Postgres 16 + MinIO (optional — the app boots with zero config).
up:
	cd infra && docker compose up -d

down:
	cd infra && docker compose down

migrate:
	cd backend && .venv/bin/alembic upgrade head

backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 7002

frontend:
	cd frontend && npm run dev

# Rebuild the embeddable widget bundle (served at /liveface.js).
embed:
	cd embed && npm run build

test:
	cd backend && .venv/bin/python -m pytest -q

typecheck:
	cd frontend && npx tsc -b
	cd embed && npx tsc -b
