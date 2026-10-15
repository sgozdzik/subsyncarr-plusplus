"""The claudesynchro pipeline: subtitle + video in, synchronised SRT and a report out."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import __version__
from .align import AlignmentError, align
from .config import Settings
from .embeddings import make_embedder
from .gapfill import fill_cues
from .language import detect_language, lang_from_filename
from .media import pick_audio_stream, probe
from .references import NoReferenceError, choose_reference
from .transcribe import speech_intervals
from .subtitles import clean_text, format_srt_time, read_subtitles, write_srt

Log = Callable[[str], None]


@dataclass
class Outcome:
    status: str  # "synced" | "low_confidence" | "skipped" | "setup_error" | "error"
    message: str
    output: str | None = None
    confidence: float | None = None
    report: dict = field(default_factory=dict)

    @property
    def exit_code(self) -> int:
        return {"synced": 0, "low_confidence": 2, "skipped": 3, "setup_error": 4}.get(self.status, 1)


def default_output_path(subtitle: Path, video: Path, lang: str | None) -> Path:
    stem = subtitle.name.rsplit(".", 1)[0]
    if lang and lang_from_filename(subtitle, video.stem) is None:
        stem = f"{stem}.{lang}"
    return subtitle.with_name(f"{stem}.claudesynchro.srt")


def _speed_label(speed: float) -> str:
    if abs(speed - 1) < 0.0005:
        return ""
    for a, b in ((23.976, 25), (25, 23.976), (24, 25), (25, 24), (23.976, 24), (24, 23.976)):
        if abs(speed - a / b) < 0.0015:
            return f"frame rate {a:g}→{b:g}"
    return f"speed ×{speed:.4f}"


def run(
    video: Path,
    subtitle: Path,
    output: Path | None,
    settings: Settings,
    log: Log,
    reference_file: Path | None = None,
    check_language: bool = True,
) -> Outcome:
    started = time.time()
    info = probe(video)
    sub = read_subtitles(subtitle, fps=info.fps)
    t_text = [clean_text(c.text) for c in sub.cues]
    target_lang = lang_from_filename(subtitle, video.stem) or detect_language(t_text)
    log(
        f"Subtitles: {subtitle.name} ({sub.format}, {sub.encoding}, {len(sub.cues)} lines, "
        f"language {target_lang or 'unknown'})"
    )
    if check_language and settings.languages and target_lang not in settings.languages:
        return Outcome("skipped", f"Not a target language ({target_lang or 'unknown'}; syncing {','.join(settings.languages)})")
    if len(sub.cues) < 10:
        return Outcome("skipped", f"Only {len(sub.cues)} subtitle lines")

    output = output or default_output_path(subtitle, video, target_lang)
    last_pct = [-1]

    def progress(fraction: float) -> None:
        pct = int(fraction * 100) // 10 * 10
        if pct > last_pct[0]:
            last_pct[0] = pct
            log(f"Transcribing: {pct}%")

    try:
        reference = choose_reference(info, video, subtitle, sub.cues, target_lang, settings, log, progress, reference_file)
    except NoReferenceError as err:
        return Outcome("skipped", str(err))

    r_text = [clean_text(c.text) for c in reference.cues]
    embedder = make_embedder(settings, log)
    log(f"Embedding {len(t_text)} + {len(r_text)} lines")
    et = embedder.embed(t_text)
    er = embedder.embed(r_text)

    # Speech activity helps where the reference is sparse (transcripts). It is cached by the
    # transcription / external-reference check, so this costs nothing extra in those cases.
    speech = None
    if reference.kind in ("transcript", "external"):
        stream = pick_audio_stream(info, settings.reference_languages)
        if stream is not None and (reference.is_transcript or settings.verify_external):
            speech = speech_intervals(info, stream, settings, log)

    try:
        alignment = align(
            sub.cues, reference.cues, t_text, r_text, et, er,
            duration=info.duration or None,
            is_transcript=reference.is_transcript,
            fill_min_seconds=settings.gap_fill_min_seconds,
            speech=speech,
        )
    except AlignmentError as err:
        return Outcome("low_confidence", str(err), confidence=0.0)

    fills = fill_cues(alignment, reference, target_lang, settings, log)
    final = sorted(alignment.cues + fills, key=lambda c: (c.start, c.end))

    dropped = [i for i, k in enumerate(alignment.assignment) if k is None]
    report = {
        "version": __version__,
        "video": str(video),
        "subtitle": str(subtitle),
        "subtitle_format": sub.format,
        "subtitle_encoding": sub.encoding,
        "language": target_lang,
        "reference": {
            "kind": reference.kind,
            "label": reference.label,
            "language": reference.language,
            "lines": len(reference.cues),
        },
        "embeddings": embedder.name,
        "speed": alignment.speed,
        "segments": [
            {
                "subtitle_from": format_srt_time(sub.cues[seg.first].start),
                "subtitle_to": format_srt_time(sub.cues[seg.last].end),
                "offset": round(seg.offset, 3),
                "anchors": len(seg.anchors),
                "mad": round(seg.mad, 3),
            }
            for seg in alignment.segments
        ],
        "cuts": [
            {
                "subtitle_time": format_srt_time(c.subtitle_time),
                "video_time": format_srt_time(c.video_time),
                "jump": round(c.jump, 2),
                "kind": "video has extra scene/break" if c.jump > 0 else "subtitles have extra lines",
                "dropped": c.dropped,
            }
            for c in alignment.cuts
        ],
        "dropped_lines": [
            {"time": format_srt_time(sub.cues[i].start), "text": sub.cues[i].text} for i in dropped[:40]
        ],
        "filled": {
            "mode": settings.gap_fill,
            "lines": len(fills),
            "regions": [
                {"from": format_srt_time(r.start), "to": format_srt_time(r.end), "kind": r.kind}
                for r in alignment.regions
            ],
        },
        "stats": alignment.stats,
        "confidence": round(alignment.confidence, 3),
    }

    parts = [f"confidence {alignment.confidence:.0%}", f"ref: {reference.label}"]
    if label := _speed_label(alignment.speed):
        parts.append(label)
    if alignment.cuts:
        parts.append(f"{len(alignment.cuts)} cut(s)")
    if dropped:
        parts.append(f"{len(dropped)} line(s) dropped")
    if fills:
        parts.append(f"{len(fills)} line(s) filled")
    summary = " · ".join(parts)

    if alignment.confidence < settings.min_confidence:
        report["status"] = "low_confidence"
        status, out_path = "low_confidence", None
        message = f"Not written, {summary} (minimum {settings.min_confidence:.0%})"
    else:
        write_srt(final, output)
        report["status"] = "synced"
        status, out_path = "synced", str(output)
        message = summary
    report["output"] = out_path
    report["seconds"] = round(time.time() - started, 1)

    try:
        settings.reports_dir.mkdir(parents=True, exist_ok=True)
        name = hashlib.sha1(str(subtitle).encode("utf-8")).hexdigest()[:16] + ".json"
        (settings.reports_dir / name).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass
    return Outcome(status, message, out_path, alignment.confidence, report)
