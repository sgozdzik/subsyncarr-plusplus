"""Language codes, filename language tags and a small stop-word language detector."""

from __future__ import annotations

import re
from pathlib import Path

_ISO3_TO_ISO1 = {
    "eng": "en", "pol": "pl", "ger": "de", "deu": "de", "fre": "fr", "fra": "fr", "spa": "es",
    "ita": "it", "rus": "ru", "cze": "cs", "ces": "cs", "slo": "sk", "slk": "sk", "jpn": "ja",
    "kor": "ko", "chi": "zh", "zho": "zh", "por": "pt", "dut": "nl", "nld": "nl", "swe": "sv",
    "nor": "no", "nob": "no", "dan": "da", "fin": "fi", "hun": "hu", "ukr": "uk", "tur": "tr",
    "gre": "el", "ell": "el", "heb": "he", "ara": "ar", "hin": "hi", "tha": "th", "vie": "vi",
    "ind": "id", "rum": "ro", "ron": "ro", "bul": "bg", "hrv": "hr", "srp": "sr", "slv": "sl",
    "lit": "lt", "lav": "lv", "est": "et",
}
_NAMES = {
    "english": "en", "polish": "pl", "polski": "pl", "german": "de", "french": "fr",
    "spanish": "es", "italian": "it", "russian": "ru", "czech": "cs", "dutch": "nl",
    "portuguese": "pt", "swedish": "sv", "norwegian": "no", "danish": "da", "finnish": "fi",
    "hungarian": "hu", "ukrainian": "uk", "turkish": "tr", "japanese": "ja", "korean": "ko",
    "chinese": "zh",
}
_ISO1 = set(_ISO3_TO_ISO1.values())


def normalize_lang(code: str | None) -> str | None:
    """'eng' / 'en-US' / 'English' -> 'en'. Returns None for unknown or 'und'."""
    if not code:
        return None
    c = code.strip().lower().replace("_", "-")
    if c in ("und", "unk", "mul", "zxx", ""):
        return None
    base = c.split("-")[0]
    if base in _ISO1:
        return base
    if base in _ISO3_TO_ISO1:
        return _ISO3_TO_ISO1[base]
    return _NAMES.get(base)


def lang_from_filename(sub_path: str | Path, video_stem: str | None = None) -> str | None:
    """Language tag in a subtitle filename such as 'Movie (2024).pl.srt' or 'Movie.eng.forced.srt'."""
    name = Path(sub_path).name
    stem = name.rsplit(".", 1)[0]
    if video_stem and stem.startswith(video_stem):
        stem = stem[len(video_stem) :]
    for token in reversed([t for t in re.split(r"[.\s_\[\]()-]+", stem) if t]):
        lang = normalize_lang(token)
        if lang:
            return lang
    return None


_STOPWORDS = {
    "pl": "nie się jest to że co jak na w z do mi ci ale tak już czy ty ja mnie jestem tego go jej "
    "jego tu tam był była było mam masz może teraz wszystko dobrze wiem chcę proszę dlaczego gdzie "
    "kiedy który która które bo też tylko",
    "en": "the you to and is it i that what of a in me this don't we he she they was are have not "
    "be for on with just know your my can no yes do there all here so get",
    "de": "ich du nicht das ist die der und sie es was zu ein wir mir den mich er ja nein haben bin",
    "fr": "je tu pas le la les est de et que vous il elle un une ce nous moi c'est qui ne en oui",
    "es": "que no de la el es y en lo un por me se los qué con una para te mi está sí",
    "it": "che non di il la è e un per mi ti ma sono lo cosa ho questo sì bene",
    "cs": "je to že se na ne co jsem jak ale tak už mi ty já by jsi tady",
}
_STOP = {lang: set(words.split()) for lang, words in _STOPWORDS.items()}
_WORD_RE = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?", re.UNICODE)


def detect_language(texts: list[str]) -> str | None:
    """Very small detector, good enough to tell Polish subtitles from English ones."""
    sample = " ".join(texts[:400]).lower()
    if re.search(r"[а-яё]", sample):
        return "ru"
    words = _WORD_RE.findall(sample)
    if len(words) < 20:
        return None
    scores = {lang: sum(1 for w in words if w in stop) for lang, stop in _STOP.items()}
    scores["pl"] += 3 * len(re.findall(r"[ąćęłńśźż]", sample))
    scores["cs"] += 3 * len(re.findall(r"[ěřůčšž]", sample))
    best = max(scores, key=lambda k: scores[k])
    if scores[best] < max(5, 0.05 * len(words)):
        return None
    return best
