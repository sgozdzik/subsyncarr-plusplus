"""Filling scenes that are in the video but not in the subtitles.

"english" copies the reference lines (e.g. the English track) into those scenes,
"translate" has an LLM (OpenRouter) translate them, using the surrounding subtitle
lines as context so that names and grammatical gender stay consistent.
"""

from __future__ import annotations

import json
import re
from typing import Callable

from .align import Alignment
from .config import Settings
from .openrouter import OpenRouterError, chat
from .references import Reference
from .subtitles import Cue

Log = Callable[[str], None]

LANGUAGE_NAMES = {
    "pl": "Polish", "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian",
    "cs": "Czech", "sk": "Slovak", "ru": "Russian", "uk": "Ukrainian", "pt": "Portuguese", "nl": "Dutch",
}


def fill_cues(
    alignment: Alignment,
    reference: Reference,
    target_lang: str | None,
    settings: Settings,
    log: Log,
) -> list[Cue]:
    mode = settings.gap_fill
    if mode not in ("english", "translate") or not alignment.regions:
        return []
    if reference.is_transcript and not settings.gap_fill_from_transcript:
        log(
            f"{len(alignment.regions)} scene(s) without subtitles left empty "
            "(reference is a transcript; set CLAUDESYNCHRO_GAP_FILL_FROM_TRANSCRIPT=true to fill them)"
        )
        return []

    groups: list[list[Cue]] = []
    for region in alignment.regions:
        group = []
        for j in region.reference_indices:
            ref = reference.cues[j]
            start = max(ref.start, region.start + 0.05)
            end = min(ref.end, region.end - 0.05) if region.kind == "cut" else ref.end
            if end - start >= 0.3:
                group.append(Cue(start, end, ref.text))
        if group:
            groups.append(group)

    if mode == "translate" and target_lang and target_lang != reference.language:
        for group in groups:
            try:
                _translate_group(group, alignment.cues, reference.language, target_lang, settings)
            except (OpenRouterError, ValueError) as err:
                log(f"Translation failed, keeping {LANGUAGE_NAMES.get(reference.language or '', 'reference')} lines: {err}")
                break

    out = []
    for group in groups:
        for cue in group:
            out.append(Cue(cue.start, cue.end, settings.gap_fill_prefix + cue.text))
    return out


def _context(cues: list[Cue], start: float, end: float, count: int = 12) -> tuple[list[str], list[str]]:
    before = [c.text for c in cues if c.end <= start][-count:]
    after = [c.text for c in cues if c.start >= end][:count]
    return before, after


def _translate_group(
    group: list[Cue], subtitle_cues: list[Cue], source_lang: str | None, target_lang: str, settings: Settings
) -> None:
    source = LANGUAGE_NAMES.get(source_lang or "", "the source language")
    target = LANGUAGE_NAMES.get(target_lang, target_lang)
    before, after = _context(subtitle_cues, group[0].start, group[-1].end)
    payload = {
        "context_before": before,
        "lines": [{"id": i, "text": c.text} for i, c in enumerate(group)],
        "context_after": after,
    }
    system = (
        f"You translate film subtitles from {source} into {target}. The context lines come from the "
        f"existing {target} subtitles of the same film, right before and after the scene you translate. "
        "Use them to infer who is speaking and to whom, and use the correct grammatical gender "
        "(e.g. verb endings), names, forms of address and tone. Keep each line short and natural, "
        "keep '<i>' tags and line breaks where sensible, and translate every line separately. "
        'Answer with JSON only: {"lines": [{"id": 0, "text": "..."}]}.'
    )
    reply = chat(
        settings,
        [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    )
    match = re.search(r"\{.*\}", reply, re.DOTALL)
    if not match:
        raise ValueError("no JSON in translation reply")
    data = json.loads(match.group(0))
    by_id = {int(x["id"]): str(x["text"]) for x in data.get("lines", []) if "id" in x and "text" in x}
    if len(by_id) < len(group):
        raise ValueError(f"translation returned {len(by_id)} of {len(group)} lines")
    for i, cue in enumerate(group):
        cue.text = by_id[i].strip()
