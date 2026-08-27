"""Render voice-clone jobs queued from the dashboard.

Run this on the machine with the hardware — an Apple Silicon Mac or a CUDA
box. It polls the server for jobs the dashboard recorded, renders each line
with Chatterbox, uploads the audio, and reports progress, so the person at
the dashboard watches the clone appear without touching a terminal.

    python -m scripts.clone_worker \
        --api https://avatar.example.com/api \
        --email you@example.com \
        --org ORG_ID

The password is asked for interactively (never an argument: arguments land
in shell history and process lists). Alternatively pass --token if you
already have one. Logging in itself also means the worker can refresh when
the short-lived token expires, which a pasted token cannot.

Setup (once)::

    pip install chatterbox-tts resemble-perth "setuptools<81" requests

The consent attestation happened in the dashboard when the job was created;
this worker only renders what was already attested.
"""

from __future__ import annotations

import argparse
import io
import sys
import time
import wave

POLL_SECONDS = 5
SAMPLE_WIDTH = 2


def _to_wav_bytes(tensor, sample_rate: int) -> bytes:
    import numpy as np

    samples = tensor.squeeze().detach().cpu().numpy()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(SAMPLE_WIDTH)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True, help="API base URL incl. any /api prefix")
    parser.add_argument("--email", help="dashboard login; password is prompted")
    parser.add_argument("--token", help="alternative to --email: a ready access token")
    parser.add_argument("--org", required=True)
    parser.add_argument("--device", default="mps", help="mps (Apple), cuda, or cpu")
    parser.add_argument("--once", action="store_true", help="drain the queue, then exit")
    args = parser.parse_args()

    import requests
    import tempfile

    base = args.api.rstrip("/")

    password: str | None = None

    def login() -> str:
        nonlocal password
        if password is None:
            import getpass

            password = getpass.getpass(f"password for {args.email}: ")
        response = requests.post(
            f"{base}/auth/login",
            json={"username_or_email": args.email, "password": password},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()["access_token"]

    if not args.token and not args.email:
        print("Pass --email (interactive password) or --token", file=sys.stderr)
        return 2
    token = args.token or login()
    headers = {"Authorization": f"Bearer {token}"}

    def refresh_auth() -> None:
        """Access tokens are short-lived; a logged-in worker just logs in
        again, which is the whole reason --email beats a pasted token."""
        if not args.email:
            raise RuntimeError("token expired — restart with a fresh --token or use --email")
        headers["Authorization"] = f"Bearer {login()}"

    def request(method: str, url: str, **kwargs):
        response = requests.request(method, url, headers=headers, timeout=kwargs.pop("timeout", 60), **kwargs)
        if response.status_code == 401:
            refresh_auth()
            response = requests.request(method, url, headers=headers, timeout=60, **kwargs)
        return response

    from chatterbox.tts import ChatterboxTTS

    print(f"loading Chatterbox on {args.device} …", flush=True)
    model = ChatterboxTTS.from_pretrained(device=args.device)
    print("worker ready — waiting for jobs (Ctrl-C to stop)", flush=True)

    idle_reported = False
    while True:
        response = request("POST", f"{base}/orgs/{args.org}/clone-jobs/claim", timeout=30)
        if response.status_code == 404:
            if args.once:
                print("queue empty — done")
                return 0
            if not idle_reported:
                print("queue empty — polling", flush=True)
                idle_reported = True
            time.sleep(POLL_SECONDS)
            continue
        response.raise_for_status()
        job = response.json()
        idle_reported = False
        job_id, name, lines = job["id"], job["name"], job["lines"]
        print(f"\njob {job_id[:8]}: voice '{name}', {len(lines)} line(s)", flush=True)

        try:
            reference = requests.get(job["reference_url"], timeout=60)
            reference.raise_for_status()
            with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
                handle.write(reference.content)
                handle.flush()
                model.prepare_conditionals(handle.name)
            print("  cloned the reference", flush=True)

            for index, text in enumerate(lines, start=1):
                started = time.time()
                audio = _to_wav_bytes(model.generate(text), model.sr)
                upload = request(
                    "POST",
                    f"{base}/orgs/{args.org}/cloned-voices/{name}/lines",
                    data={"text": text, "locale": job["locale"], "consent": "true"},
                    files={"audio": (f"{index:03d}.wav", audio, "audio/wav")},
                    timeout=120,
                )
                upload.raise_for_status()
                request(
                    "POST",
                    f"{base}/orgs/{args.org}/clone-jobs/{job_id}/progress",
                    json={"done_lines": index},
                    timeout=30,
                )
                print(f"  [{index}/{len(lines)}] rendered in {time.time()-started:4.1f}s — {text[:60]}", flush=True)

            request(
                "POST", f"{base}/orgs/{args.org}/clone-jobs/{job_id}/complete", timeout=30
            ).raise_for_status()
            print(f"  done: '{name}' is ready in the dashboard", flush=True)
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # report, then keep serving the queue
            detail = getattr(getattr(exc, "response", None), "text", "")[:200]
            message = f"{type(exc).__name__}: {exc} {detail}".strip()[:900]
            print(f"  FAILED: {message}", file=sys.stderr, flush=True)
            try:
                request(
                    "POST",
                    f"{base}/orgs/{args.org}/clone-jobs/{job_id}/fail",
                    json={"error": message},
                    timeout=30,
                )
            except Exception:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nstopped")
