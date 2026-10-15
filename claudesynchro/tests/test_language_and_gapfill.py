import json

import numpy as np

from claudesynchro import gapfill
from claudesynchro.align import Alignment, Region
from claudesynchro.config import Settings
from claudesynchro.language import detect_language, lang_from_filename, normalize_lang
from claudesynchro.references import Reference
from claudesynchro.subtitles import Cue


def test_language_tags():
    assert lang_from_filename("Movie (2024).pl.srt", "Movie (2024)") == "pl"
    assert lang_from_filename("Movie (2024).eng.sdh.srt", "Movie (2024)") == "en"
    assert lang_from_filename("Movie (2024).srt", "Movie (2024)") is None
    # Titles that look like language codes are not tags.
    assert lang_from_filename("It (2017).srt", "It (2017)") is None
    assert normalize_lang("pol") == "pl" and normalize_lang("und") is None


def test_detect_language():
    pl = ["Nie wiem, co się stało.", "Jestem przerażona!", "Dlaczego tu jesteś?", "To nie moja wina."] * 5
    en = ["I don't know what happened.", "You are not supposed to be here.", "What is that?"] * 6
    assert detect_language(pl) == "pl"
    assert detect_language(en) == "en"


def _alignment_with_region(ref_cues):
    region = Region(10.0, 30.0, list(range(len(ref_cues))), "cut")
    return Alignment(
        speed=1.0, segments=[], assignment=[], cues=[Cue(5, 8, "Zrobiłam to."), Cue(31, 33, "Chodźmy.")],
        source_index=[0, 1], verified=[], cuts=[], regions=[region], confidence=1.0,
    )


def test_gap_fill_english_and_transcript_default():
    ref = Reference("embedded", "track", "en", [Cue(12, 14, "Where were you?"), Cue(15, 17, "At home.")])
    settings = Settings()
    settings.gap_fill = "english"
    settings.gap_fill_prefix = "[EN] "
    out = gapfill.fill_cues(_alignment_with_region(ref.cues), ref, "pl", settings, lambda m: None)
    assert [c.text for c in out] == ["[EN] Where were you?", "[EN] At home."]

    transcript = Reference("transcript", "audio", "en", ref.cues)
    assert gapfill.fill_cues(_alignment_with_region(ref.cues), transcript, "pl", settings, lambda m: None) == []


def test_gap_fill_translate_uses_context(monkeypatch):
    ref = Reference("embedded", "track", "en", [Cue(12, 14, "Where were you?"), Cue(15, 17, "At home.")])
    settings = Settings()
    settings.gap_fill = "translate"
    seen = {}

    def fake_chat(_settings, messages, temperature=0.2):
        payload = json.loads(messages[1]["content"])
        seen.update(payload)
        return json.dumps({"lines": [{"id": 0, "text": "Gdzie byłaś?"}, {"id": 1, "text": "W domu."}]})

    monkeypatch.setattr(gapfill, "chat", fake_chat)
    out = gapfill.fill_cues(_alignment_with_region(ref.cues), ref, "pl", settings, lambda m: None)
    assert [c.text for c in out] == ["Gdzie byłaś?", "W domu."]
    assert seen["context_before"] == ["Zrobiłam to."] and seen["context_after"] == ["Chodźmy."]


def test_gap_fill_translate_failure_keeps_english(monkeypatch):
    ref = Reference("embedded", "track", "en", [Cue(12, 14, "Where were you?")])
    settings = Settings()
    settings.gap_fill = "translate"
    monkeypatch.setattr(gapfill, "chat", lambda *a, **k: "sorry, no JSON")
    out = gapfill.fill_cues(_alignment_with_region(ref.cues), ref, "pl", settings, lambda m: None)
    assert [c.text for c in out] == ["Where were you?"]
    assert np.isfinite(out[0].start)
