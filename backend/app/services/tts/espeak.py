"""Text to IPA, for every language that is not English.

espeak-ng is a speech synthesiser, but the only part used here is its
grapheme-to-phoneme front end: `-q` suppresses the audio and `--ipa` prints
the pronunciation. That front end covers around a hundred languages, which is
the entire reason this exists — the alternative is hand-writing a rule table
per language, which does not scale past the languages the author speaks.

Called as a subprocess rather than through a binding. The binding options wrap
the same binary, add a dependency that has to track its ABI, and buy nothing
here: this runs once per utterance, alongside speech synthesis that takes
orders of magnitude longer.

Absence is normal, not an error. Development machines mostly do not have
espeak-ng, so a missing binary falls back to the character path rather than
failing the request — the avatar still speaks, just less precisely.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from functools import lru_cache

logger = logging.getLogger("liveface.espeak")

BINARY = "espeak-ng"

# Generous next to synthesis, tight enough that a wedged subprocess cannot
# hold a request open.
TIMEOUT_SECONDS = 5

# espeak takes a language subtag, not a full locale: "fr", not "fr-FR". A few
# need the region to pick the right variety.
_VOICE_OVERRIDES = {
    "pt-br": "pt-br",
    "zh-tw": "zh-yue",
    "en-gb": "en-gb",
}


@lru_cache(maxsize=1)
def available() -> bool:
    return shutil.which(BINARY) is not None


def voice_for(locale: str) -> str:
    tag = locale.lower().replace("_", "-")
    return _VOICE_OVERRIDES.get(tag, tag.split("-")[0])


@lru_cache(maxsize=4096)
def text_to_ipa(text: str, locale: str) -> str | None:
    """IPA for `text`, or None if espeak-ng cannot help.

    Cached: the same greeting is spoken over and over by a website avatar, and
    the result depends only on the text and the language.
    """
    if not available() or not text.strip():
        return None
    try:
        result = subprocess.run(
            [BINARY, "-q", "--ipa=1", "-v", voice_for(locale), "--", text],
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
            # Never a shell: the text is user input, and building a command
            # line out of it is how you get a shell injection.
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        logger.exception("espeak-ng failed for locale %s", locale)
        return None

    if result.returncode != 0:
        # Unknown language is the common case and is not worth a stack trace.
        logger.info("espeak-ng rejected locale %s: %s", locale, result.stderr[:200])
        return None
    ipa = result.stdout.decode("utf-8", "replace").strip()
    return ipa or None


def supports(locale: str) -> bool:
    """Whether this locale can be phonemised right now.

    Asks espeak rather than consulting a list, so the answer reflects what is
    actually installed instead of what was true when the list was written.
    """
    if not available():
        return False
    return text_to_ipa("test", locale) is not None
