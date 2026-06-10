"""Real TTS providers (Azure, ElevenLabs, Google, OpenAI).

Each appears in /tts/providers only when its credentials are configured
(env or dashboard-managed; the credential store decides). All results are
normalized to SynthesisResult with 15-viseme cue tracks.
"""
from __future__ import annotations

import io
import json
import time
import wave

import httpx

from app.core.credentials import credentials
from app.services.tts.base import SynthesisResult, TTSProvider, Voice
from app.services.tts.visemes import char_to_viseme, cues_from_text

HTTP_TIMEOUT = 30.0


def _wav_duration_ms(data: bytes) -> int:
    with wave.open(io.BytesIO(data)) as wav:
        return int(wav.getnframes() * 1000 / wav.getframerate())


# Azure's viseme event ids -> Oculus visemes.
AZURE_VISEME_MAP = {
    0: "sil", 1: "aa", 2: "aa", 3: "oh", 4: "E", 5: "RR", 6: "ih", 7: "ou",
    8: "oh", 9: "aa", 10: "oh", 11: "aa", 12: "kk", 13: "RR", 14: "nn",
    15: "SS", 16: "CH", 17: "TH", 18: "FF", 19: "DD", 20: "kk", 21: "PP",
}


class AzureTTSProvider(TTSProvider):
    name = "azure"
    display_name = "Azure Speech"

    def is_configured(self) -> bool:
        return bool(credentials.get("azure_speech_key") and credentials.get("azure_speech_region"))

    def _region(self) -> str:
        return credentials.get("azure_speech_region") or ""

    async def voices(self) -> list[Voice]:
        url = f"https://{self._region()}.tts.speech.microsoft.com/cognitiveservices/voices/list"
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.get(
                url, headers={"Ocp-Apim-Subscription-Key": credentials.get("azure_speech_key") or ""}
            )
            response.raise_for_status()
        return [
            Voice(
                id=v["ShortName"],
                name=v["DisplayName"],
                locale=v["Locale"],
                gender=v.get("Gender", "neutral").lower(),
            )
            for v in response.json()
        ][:200]

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        # Native viseme events need the Speech SDK's websocket protocol; use
        # it when installed, otherwise REST audio + char-derived cues.
        try:
            return await self._synthesize_sdk(text, voice, locale)
        except ImportError:
            return await self._synthesize_rest(text, voice, locale)

    async def _synthesize_sdk(self, text: str, voice: str, locale: str) -> SynthesisResult:
        import asyncio

        import azure.cognitiveservices.speech as speechsdk  # optional dependency

        def run() -> tuple[bytes, list[dict]]:
            config = speechsdk.SpeechConfig(
                subscription=credentials.get("azure_speech_key"), region=self._region()
            )
            config.speech_synthesis_voice_name = voice
            config.set_speech_synthesis_output_format(
                speechsdk.SpeechSynthesisOutputFormat.Riff22050Hz16BitMonoPcm
            )
            synthesizer = speechsdk.SpeechSynthesizer(speech_config=config, audio_config=None)
            cues: list[dict] = []
            synthesizer.viseme_received.connect(
                lambda evt: cues.append(
                    {
                        "t": int(evt.audio_offset / 10_000),  # ticks -> ms
                        "viseme": AZURE_VISEME_MAP.get(evt.viseme_id, "sil"),
                    }
                )
            )
            result = synthesizer.speak_text_async(text).get()
            if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
                raise RuntimeError(f"azure synthesis failed: {result.reason}")
            return result.audio_data, cues

        audio, cues = await asyncio.to_thread(run)
        duration = _wav_duration_ms(audio)
        cues.append({"t": duration, "viseme": "sil"})
        return SynthesisResult(audio=audio, audio_mime="audio/wav", duration_ms=duration, cues=cues)

    async def _synthesize_rest(self, text: str, voice: str, locale: str) -> SynthesisResult:
        url = f"https://{self._region()}.tts.speech.microsoft.com/cognitiveservices/v1"
        ssml = (
            f'<speak version="1.0" xml:lang="{locale or "en-US"}">'
            f'<voice name="{voice}">{text}</voice></speak>'
        )
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(
                url,
                content=ssml.encode(),
                headers={
                    "Ocp-Apim-Subscription-Key": credentials.get("azure_speech_key") or "",
                    "Content-Type": "application/ssml+xml",
                    "X-Microsoft-OutputFormat": "riff-22050hz-16bit-mono-pcm",
                },
            )
            response.raise_for_status()
        audio = response.content
        duration = _wav_duration_ms(audio)
        return SynthesisResult(
            audio=audio,
            audio_mime="audio/wav",
            duration_ms=duration,
            cues=cues_from_text(text, duration),
        )


class ElevenLabsTTSProvider(TTSProvider):
    name = "elevenlabs"
    display_name = "ElevenLabs"

    def is_configured(self) -> bool:
        return bool(credentials.get("elevenlabs_api_key"))

    async def voices(self) -> list[Voice]:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.get(
                "https://api.elevenlabs.io/v1/voices",
                headers={"xi-api-key": credentials.get("elevenlabs_api_key") or ""},
            )
            response.raise_for_status()
        return [
            Voice(id=v["voice_id"], name=v["name"], locale=v.get("labels", {}).get("language", "en"))
            for v in response.json().get("voices", [])
        ]

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        # with-timestamps returns base64 audio + per-character alignment,
        # which maps 1:1 onto viseme cues.
        import base64

        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                url,
                headers={"xi-api-key": credentials.get("elevenlabs_api_key") or ""},
                json={"text": text, "model_id": "eleven_multilingual_v2"},
            )
            response.raise_for_status()
        payload = response.json()
        audio = base64.b64decode(payload["audio_base64"])
        alignment = payload.get("alignment") or {}
        chars = alignment.get("characters", [])
        starts = alignment.get("character_start_times_seconds", [])
        cues: list[dict] = []
        last = None
        for ch, start in zip(chars, starts):
            viseme = char_to_viseme(ch)
            if viseme != last:
                cues.append({"t": int(start * 1000), "viseme": viseme})
                last = viseme
        ends = alignment.get("character_end_times_seconds", [])
        duration = int((ends[-1] if ends else 0) * 1000)
        if duration == 0:
            duration = len(text) * 75
            cues = cues_from_text(text, duration)
        else:
            cues.append({"t": duration, "viseme": "sil"})
        return SynthesisResult(audio=audio, audio_mime="audio/mpeg", duration_ms=duration, cues=cues)


class GoogleTTSProvider(TTSProvider):
    name = "google"
    display_name = "Google Cloud TTS"

    def is_configured(self) -> bool:
        return bool(credentials.get("google_tts_credentials_json"))

    def _service_account(self) -> dict:
        raw = credentials.get("google_tts_credentials_json") or ""
        raw = raw.strip()
        if raw.startswith("{"):
            return json.loads(raw)
        with open(raw) as f:  # a file path was provided instead of inline JSON
            return json.load(f)

    async def _access_token(self) -> str:
        from jose import jwt as jose_jwt

        sa = self._service_account()
        now = int(time.time())
        assertion = jose_jwt.encode(
            {
                "iss": sa["client_email"],
                "scope": "https://www.googleapis.com/auth/cloud-platform",
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            },
            sa["private_key"],
            algorithm="RS256",
        )
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
            )
            response.raise_for_status()
        return response.json()["access_token"]

    async def voices(self) -> list[Voice]:
        token = await self._access_token()
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await client.get(
                "https://texttospeech.googleapis.com/v1/voices",
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
        return [
            Voice(
                id=v["name"],
                name=v["name"],
                locale=(v.get("languageCodes") or ["en-US"])[0],
                gender=v.get("ssmlGender", "neutral").lower(),
            )
            for v in response.json().get("voices", [])
        ][:200]

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        import base64

        token = await self._access_token()
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "input": {"text": text},
                    "voice": {"name": voice, "languageCode": locale or "en-US"},
                    "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 22050},
                },
            )
            response.raise_for_status()
        audio = base64.b64decode(response.json()["audioContent"])
        duration = _wav_duration_ms(audio)
        # Google has no timing events on the basic API: coarse char cues.
        return SynthesisResult(
            audio=audio,
            audio_mime="audio/wav",
            duration_ms=duration,
            cues=cues_from_text(text, duration),
        )


class OpenAITTSProvider(TTSProvider):
    name = "openai"
    display_name = "OpenAI TTS"

    VOICE_IDS = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]

    def is_configured(self) -> bool:
        return bool(credentials.get("openai_api_key"))

    async def voices(self) -> list[Voice]:
        return [Voice(id=v, name=v.title(), locale="en-US") for v in self.VOICE_IDS]

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/audio/speech",
                headers={"Authorization": f"Bearer {credentials.get('openai_api_key')}"},
                json={"model": "tts-1", "voice": voice, "input": text, "response_format": "wav"},
            )
            response.raise_for_status()
        audio = response.content
        duration = _wav_duration_ms(audio)
        # Audio only — no timing data from the API; derive cues from text.
        return SynthesisResult(
            audio=audio,
            audio_mime="audio/wav",
            duration_ms=duration,
            cues=cues_from_text(text, duration),
        )
