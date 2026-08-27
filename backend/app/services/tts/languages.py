"""What we can speak, and who speaks it best.

Two things live here because they answer the same question — "the user chose
this language, now what?":

1. LANGUAGES: the metadata a language picker needs — the name in English,
   the name in its own script (nobody hunting for their language scans for
   "Persian"; they scan for "فارسی"), and a sample line in that language so
   pressing Speak demonstrates something the user can actually judge.

2. resolve(): which provider and voice to use. Callers should never have to
   know that Kokoro speaks Spanish and Piper speaks Persian; they name a
   language and get the best available voice for it.

The order is fixed and quality-descending: Kokoro, then Piper. It is not a
preference the caller can invert, because "best voice for this language" has
one right answer per deployment and scattering that choice across the
dashboard, the widget and the share page is how the three drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    locale: str
    name: str          # English, for the picker's secondary label
    native_name: str   # Its own script, for the primary label
    sample: str        # A line to demonstrate the voice


# Ordered as the picker shows them: English first because it is the default,
# then everything else alphabetically by English name.
LANGUAGES: tuple[Language, ...] = (
    Language("en-US", "English (US)", "English (US)",
             "Hi, I'm your virtual assistant. How can I help you today?"),
    Language("en-GB", "English (UK)", "English (UK)",
             "Hello, I'm your virtual assistant. How can I help you today?"),
    Language("ar-JO", "Arabic", "العربية",
             "مرحباً، أنا مساعدك الافتراضي. كيف يمكنني مساعدتك اليوم؟"),
    Language("nl-NL", "Dutch", "Nederlands",
             "Hallo, ik ben je virtuele assistent. Waarmee kan ik je helpen?"),
    Language("fr-FR", "French", "Français",
             "Bonjour, je suis votre assistant virtuel. Comment puis-je vous aider ?"),
    Language("de-DE", "German", "Deutsch",
             "Hallo, ich bin Ihr virtueller Assistent. Wie kann ich Ihnen helfen?"),
    Language("hi-IN", "Hindi", "हिन्दी",
             "नमस्ते, मैं आपका वर्चुअल असिस्टेंट हूँ। मैं आपकी कैसे मदद कर सकता हूँ?"),
    Language("it-IT", "Italian", "Italiano",
             "Ciao, sono il tuo assistente virtuale. Come posso aiutarti oggi?"),
    Language("fa-IR", "Persian", "فارسی",
             "سلام، من دستیار مجازی شما هستم. چطور می‌توانم کمکتان کنم؟"),
    Language("pl-PL", "Polish", "Polski",
             "Cześć, jestem twoim wirtualnym asystentem. W czym mogę pomóc?"),
    Language("pt-BR", "Portuguese (Brazil)", "Português",
             "Olá, sou seu assistente virtual. Como posso ajudar você hoje?"),
    Language("ru-RU", "Russian", "Русский",
             "Здравствуйте, я ваш виртуальный помощник. Чем я могу вам помочь?"),
    Language("es-ES", "Spanish", "Español",
             "Hola, soy tu asistente virtual. ¿En qué puedo ayudarte hoy?"),
    Language("tr-TR", "Turkish", "Türkçe",
             "Merhaba, ben sanal asistanınızım. Size bugün nasıl yardımcı olabilirim?"),
)

BY_LOCALE = {language.locale: language for language in LANGUAGES}

# Quality order. Kokoro is closer to a paid API; Piper is clearly synthetic
# but covers languages Kokoro has never heard of.
PROVIDER_ORDER = ("kokoro", "piper")


async def resolve(locale: str) -> tuple[str, str] | None:
    """Best (provider, voice) for a locale, or None if nothing can speak it.

    Matches the exact locale first, then the bare language: a request for
    "de-AT" should reach the German voice rather than falling through to
    silence over a region tag.
    """
    from app.services.tts.registry import _ALL_PROVIDERS

    wanted = locale.replace("_", "-").lower()
    language_only = wanted.split("-")[0]

    by_name = {p.name: p for p in _ALL_PROVIDERS}
    for name in PROVIDER_ORDER:
        provider = by_name.get(name)
        if provider is None or not provider.is_configured():
            continue
        voices = await provider.voices()
        exact = next((v for v in voices if v.locale.lower() == wanted), None)
        if exact:
            return name, exact.id
        loose = next(
            (v for v in voices if v.locale.split("-")[0].lower() == language_only), None
        )
        if loose:
            return name, loose.id
    return None


async def available_languages() -> list[dict]:
    """Every language this deployment can actually speak, resolved."""
    out = []
    for language in LANGUAGES:
        chosen = await resolve(language.locale)
        if chosen is None:
            continue
        provider, voice = chosen
        out.append(
            {
                "locale": language.locale,
                "name": language.name,
                "native_name": language.native_name,
                "sample": language.sample,
                "provider": provider,
                "voice": voice,
            }
        )
    return out
