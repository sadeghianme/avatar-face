from tests.conftest import create_org, register_and_login


async def test_stock_gallery_lists_six(client):
    response = await client.get("/stock-avatars")
    assert response.status_code == 200
    gallery = response.json()
    assert len(gallery) >= 6
    assert all(item["image_url"].startswith("http://testserver/") for item in gallery)


async def test_stock_image_served(client):
    gallery = (await client.get("/stock-avatars")).json()
    response = await client.get(gallery[0]["image_url"])
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"


async def test_unknown_stock_404(client):
    response = await client.get("/stock-avatars/nobody.png")
    assert response.status_code == 404


async def test_create_from_stock_runs_pipeline(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/from-stock",
        json={"stock_id": "nora"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    avatar_id = response.json()["id"]
    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    assert detail["status"] == "ready"
    assert detail["rig_url"] and detail["thumbnail_url"]
    assert detail["name"] == "Nora"


async def test_from_stock_unknown_id(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars/from-stock",
        json={"stock_id": "nobody"},
        headers=headers,
    )
    assert response.status_code == 404
