"""Object storage abstraction.

Two implementations behind one interface:

- S3Storage (R2 / any S3) when R2_ENDPOINT + R2_ACCESS_KEY + R2_SECRET are set.
- LocalStorage otherwise: files under LOCAL_STORAGE_DIR, with HMAC-signed
  URLs served by the /storage route that mirror presigned PUT/GET semantics.

URLs are ABSOLUTE (built from PUBLIC_BASE_URL) because the embed widget runs
on third-party origins and must be able to load textures/audio directly.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from pathlib import Path
from urllib.parse import quote, urlencode

import aioboto3

from app.core.config import get_settings


class Storage:
    async def presign_put(self, key: str, content_type: str) -> str:
        raise NotImplementedError

    async def presign_get(self, key: str) -> str:
        raise NotImplementedError

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        raise NotImplementedError

    async def get_bytes(self, key: str) -> bytes:
        raise NotImplementedError

    async def exists(self, key: str) -> bool:
        raise NotImplementedError

    async def delete(self, key: str) -> None:
        raise NotImplementedError


class LocalStorage(Storage):
    """Filesystem-backed storage with presigned-URL semantics.

    Signatures: HMAC-SHA256 over "<method>:<key>:<expiry>" with the JWT
    secret, so URLs are tamper-proof and expire like real presigned URLs.
    """

    def __init__(self, root: str | Path, base_url: str, secret: str, expiry_seconds: int):
        self.root = Path(root)
        self.base_url = base_url.rstrip("/")
        self.secret = secret.encode()
        self.expiry_seconds = expiry_seconds

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("invalid storage key")
        return path

    def sign(self, method: str, key: str, expires: int) -> str:
        message = f"{method}:{key}:{expires}".encode()
        return hmac.new(self.secret, message, hashlib.sha256).hexdigest()

    def verify(self, method: str, key: str, expires: int, signature: str) -> bool:
        if expires < int(time.time()):
            return False
        return hmac.compare_digest(self.sign(method, key, expires), signature)

    def _url(self, method: str, key: str) -> str:
        expires = int(time.time()) + self.expiry_seconds
        query = urlencode({"expires": expires, "signature": self.sign(method, key, expires)})
        return f"{self.base_url}/storage/{quote(key)}?{query}"

    async def presign_put(self, key: str, content_type: str) -> str:
        return self._url("PUT", key)

    async def presign_get(self, key: str) -> str:
        return self._url("GET", key)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    async def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    async def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    async def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()


class S3Storage(Storage):
    def __init__(self, endpoint: str, access_key: str, secret: str, bucket: str, region: str,
                 expiry_seconds: int):
        self.bucket = bucket
        self.expiry_seconds = expiry_seconds
        self._session = aioboto3.Session()
        self._client_kwargs = dict(
            service_name="s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret,
            region_name=region,
        )

    def _client(self):
        return self._session.client(**self._client_kwargs)

    async def presign_put(self, key: str, content_type: str) -> str:
        async with self._client() as s3:
            return await s3.generate_presigned_url(
                "put_object",
                Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
                ExpiresIn=self.expiry_seconds,
            )

    async def presign_get(self, key: str) -> str:
        async with self._client() as s3:
            return await s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=self.expiry_seconds,
            )

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        async with self._client() as s3:
            await s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    async def get_bytes(self, key: str) -> bytes:
        async with self._client() as s3:
            response = await s3.get_object(Bucket=self.bucket, Key=key)
            return await response["Body"].read()

    async def exists(self, key: str) -> bool:
        async with self._client() as s3:
            try:
                await s3.head_object(Bucket=self.bucket, Key=key)
                return True
            except s3.exceptions.ClientError:
                return False

    async def delete(self, key: str) -> None:
        async with self._client() as s3:
            await s3.delete_object(Bucket=self.bucket, Key=key)


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        settings = get_settings()
        if settings.storage_configured:
            _storage = S3Storage(
                endpoint=settings.r2_endpoint or "",
                access_key=settings.r2_access_key or "",
                secret=settings.r2_secret or "",
                bucket=settings.r2_bucket,
                region=settings.r2_region,
                expiry_seconds=settings.presign_expiry_seconds,
            )
        else:
            _storage = LocalStorage(
                root=settings.local_storage_dir,
                base_url=settings.public_base_url,
                secret=settings.jwt_secret,
                expiry_seconds=settings.presign_expiry_seconds,
            )
    return _storage


def reset_storage() -> None:
    """Drop the cached storage instance (used by tests when settings change)."""
    global _storage
    _storage = None
