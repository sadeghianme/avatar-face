"""Kokoro's voices as this server offers them, and its language codes.

A leaf: the Kokoro provider (services.tts.kokoro) and the timestamped model
it speaks with (services.tts.lab_timing) both need the catalogue, and each
needs the other's functions, so the catalogue cannot live in either.
"""

from __future__ import annotations

from app.services.tts.base import Voice

# A curated slice of Kokoro's 54 voices: one or two per language, not fifty
# near-identical English ones. Japanese and Mandarin are deliberately absent
# — those voices were trained with a dedicated Japanese/Chinese text
# processor (misaki), and this image phonemizes with espeak, which produces
# audio but mispronounces enough to be worse than offering nothing.
VOICES = [
    Voice(id="af_heart", name="Heart · warm female", locale="en-US", gender="female"),
    Voice(id="af_bella", name="Bella · bright female", locale="en-US", gender="female"),
    Voice(id="am_michael", name="Michael · calm male", locale="en-US", gender="male"),
    Voice(id="am_fenrir", name="Fenrir · deep male", locale="en-US", gender="male"),
    Voice(id="bf_emma", name="Emma · British female", locale="en-GB", gender="female"),
    Voice(id="bm_george", name="George · British male", locale="en-GB", gender="male"),
    Voice(id="ef_dora", name="Dora · Spanish female", locale="es-ES", gender="female"),
    Voice(id="em_alex", name="Alex · Spanish male", locale="es-ES", gender="male"),
    Voice(id="ff_siwis", name="Siwis · French female", locale="fr-FR", gender="female"),
    Voice(id="if_sara", name="Sara · Italian female", locale="it-IT", gender="female"),
    Voice(id="im_nicola", name="Nicola · Italian male", locale="it-IT", gender="male"),
    Voice(id="pf_dora", name="Dora · Portuguese female", locale="pt-BR", gender="female"),
    Voice(id="pm_alex", name="Alex · Portuguese male", locale="pt-BR", gender="male"),
    Voice(id="hf_alpha", name="Alpha · Hindi female", locale="hi-IN", gender="female"),
    Voice(id="hm_omega", name="Omega · Hindi male", locale="hi-IN", gender="male"),
]
VOICE_IDS = {v.id for v in VOICES}
# Kokoro's voice-id prefixes ARE its language codes.
LANG_BY_PREFIX = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "i": "it",
    "p": "pt-br",
    "h": "hi",
}
DEFAULT_VOICE = "af_heart"
