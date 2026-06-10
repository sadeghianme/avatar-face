from tests.conftest import register_and_login


async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_register_and_me(client):
    headers = await register_and_login(client, "alice")
    response = await client.get("/auth/me", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["username"] == "alice"
    assert "password" not in body and "password_hash" not in body


async def test_register_duplicate_email_conflicts(client):
    await register_and_login(client, "alice")
    response = await client.post(
        "/auth/register",
        json={"email": "alice@example.com", "username": "alice2", "password": "password123"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "user_exists"


async def test_register_short_password_rejected(client):
    response = await client.post(
        "/auth/register",
        json={"email": "bob@example.com", "username": "bob", "password": "short"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_login_with_email(client):
    await register_and_login(client, "alice")
    response = await client.post(
        "/auth/login",
        json={"username_or_email": "alice@example.com", "password": "password123"},
    )
    assert response.status_code == 200
    assert response.json()["access_token"]


async def test_login_wrong_password(client):
    await register_and_login(client, "alice")
    response = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": "wrong-password"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_credentials"


async def test_refresh_flow(client):
    await register_and_login(client, "alice")
    login = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": "password123"}
    )
    refresh_token = login.json()["refresh_token"]
    response = await client.post("/auth/refresh", json={"refresh_token": refresh_token})
    assert response.status_code == 200
    new_access = response.json()["access_token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {new_access}"})
    assert me.status_code == 200


async def test_access_token_rejected_as_refresh(client):
    await register_and_login(client, "alice")
    login = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": "password123"}
    )
    access = login.json()["access_token"]
    response = await client.post("/auth/refresh", json={"refresh_token": access})
    assert response.status_code == 401


async def test_me_requires_token(client):
    response = await client.get("/auth/me")
    assert response.status_code == 401
    assert response.json()["code"] == "missing_token"


async def test_garbage_token_rejected(client):
    response = await client.get("/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_token"


async def test_error_envelope_shape(client):
    response = await client.get("/auth/me")
    body = response.json()
    assert set(body) >= {"detail", "code"}


async def test_request_id_header(client):
    response = await client.get("/health")
    assert response.headers.get("x-request-id")
