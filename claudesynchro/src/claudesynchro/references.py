"""Choosing the reference timeline: embedded text track, external subtitles, or a transcript."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from .config import Settings
from .language import detect_language, lang_from_filename
from .media import TEXT_SUBTITLE_CODECS, MediaInfo, Stream, extract_subtitle_stream, pick_audio_stream
from .subtitles import Cue, clean_text, parse_subtitles, read_subtitles
from .transcribe import get_transcript, speech_intervals

Log = Callable[[str], None]

SUBTITLE_EXTENSIONS = {".srt", ".ass", ".ssa", ".vtt", ".sub", ".txt"}
ENGINE_TAGS = (".ffsubsync.", ".autosubsync.", ".alass.", ".claudesynchro.")


class NoReferenceError(RuntimeError):
    pass


@dataclass
class Reference:
    kind: str  # "embedded" | "external" | "transcript"
    label: str
    language: str | None
    cues: list[Cue]

    @property
    def is_transcript(self) -> bool:
        return self.kind == "transcript"


def _lang_rank(lang: str | None, target_lang: str | None, prefs: list[str]) -> int | None:
    """Lower is better; None means the language is not acceptable as a reference."""
    if lang is not None and lang in prefs:
        return prefs.index(lang)
    if "*" in prefs:
        # Same-language references are fine, but anything else is a closer translation match.
        return len(prefs) + (1 if lang == target_lang else 0)
    return None


def embedded_candidates(info: MediaInfo, target_lang: str | None, prefs: list[str]) -> list[Stream]:
    ranked = []
    for s in info.of_type("subtitle"):
        if s.codec not in TEXT_SUBTITLE_CODECS or s.forced:
            continue
        rank = _lang_rank(s.language, target_lang, prefs)
        if rank is None:
            continue
        ranked.append(((rank, s.hearing_impaired, not s.default, s.index), s))
    return [s for _, s in sorted(ranked, key=lambda x: x[0])]


def external_candidates(
    video: Path, subtitle: Path, target_lang: str | None, prefs: list[str]
) -> list[tuple[Path, str]]:
    ranked = []
    for p in video.parent.iterdir():
        name = p.name
        if p == subtitle or not p.is_file() or p.suffix.lower() not in SUBTITLE_EXTENSIONS:
            continue
        if not name.startswith(video.stem) or any(tag in name for tag in ENGINE_TAGS):
            continue
        if ".forced." in name.lower():
            continue
        lang = lang_from_filename(p, video.stem)
        if lang is None or lang == target_lang:
            continue
        rank = _lang_rank(lang, target_lang, prefs)
        if rank is not None:
            ranked.append(((rank, ".sdh." in name.lower(), name), p, lang))
    return [(p, lang) for _, p, lang in sorted(ranked, key=lambda x: x[0])]


def audio_agreement(cues: list[Cue], intervals: list[tuple[float, float]], duration: float) -> dict:
    """Does this subtitle timeline fit the speech in the audio? Checked in 10-minute windows,
    so a file that is in sync for the first half only (different cut) is caught too."""
    res = 0.1
    end = max(duration, max((c.end for c in cues), default=0.0)) + 5
    nbins = int(end / res) + 1
    speech = -np.ones(nbins, dtype=np.float32)
    for s, e in intervals:
        speech[int(s / res) : int(e / res) + 1] = 1.0
    window = 600.0
    max_lag = int(60 / res)
    windows = []
    t = 0.0
    while t < end:
        in_window = [c for c in cues if t <= c.start < t + window]
        if len(in_window) >= 25:
            subs = np.zeros(nbins, dtype=np.float32)
            for c in in_window:
                subs[int(c.start / res) : int(c.end / res) + 1] = 1.0
            lo = max(0, int(t / res) - max_lag)
            hi = min(nbins, int((t + window) / res) + max_lag)
            seg_speech = speech[lo:hi]
            seg_subs = subs[lo:hi]
            size = 1 << int(np.ceil(np.log2(2 * len(seg_speech))))
            corr = np.fft.irfft(np.fft.rfft(seg_speech, size) * np.conj(np.fft.rfft(seg_subs, size)), size)
            lags = np.concatenate([np.arange(0, max_lag + 1), np.arange(-max_lag, 0)])
            vals = np.concatenate([corr[: max_lag + 1], corr[size - max_lag :]])
            best = int(np.argmax(vals))
            zero = float(corr[0])
            peak = float(vals[best])
            windows.append(
                {
                    "start": t,
                    "lag": float(lags[best] * res),
                    "gain": (peak - zero) / max(abs(peak), 1e-6),
                }
            )
        t += window
    bad = [w for w in windows if abs(w["lag"]) > 1.0 and w["gain"] > 0.05]
    return {
        "windows": len(windows),
        "bad_windows": len(bad),
        "ok": bool(windows) and len(bad) <= max(0, int(0.1 * len(windows))),
        "lags": [round(w["lag"], 1) for w in windows],
    }


def choose_reference(
    info: MediaInfo,
    video: Path,
    subtitle: Path,
    target_cues: list[Cue],
    target_lang: str | None,
    settings: Settings,
    log: Log,
    progress: Callable[[float], None] | None = None,
    reference_file: Path | None = None,
) -> Reference:
    min_lines = max(20, int(0.3 * len(target_cues)))
    prefs = settings.reference_languages

    if reference_file is not None:
        ref = read_subtitles(reference_file, fps=info.fps)
        lang = lang_from_filename(reference_file, video.stem) or detect_language([clean_text(c.text) for c in ref.cues])
        return Reference("external", reference_file.name, lang, ref.cues)

    for source in settings.reference_order:
        if source == "embedded":
            for stream in embedded_candidates(info, target_lang, prefs):
                try:
                    cues, _ = parse_subtitles(extract_subtitle_stream(info.path, stream.index))
                except Exception as err:  # noqa: BLE001 - try the next track
                    log(f"Could not read embedded subtitle track #{stream.index}: {err}")
                    continue
                label = f"embedded track #{stream.index} ({stream.language or 'und'}{', ' + stream.title if stream.title else ''})"
                if len(cues) < min_lines:
                    log(f"Skipping {label}: only {len(cues)} lines")
                    continue
                lang = stream.language or detect_language([clean_text(c.text) for c in cues])
                log(f"Reference: {label}, {len(cues)} lines")
                return Reference("embedded", label, lang, cues)

        elif source == "external":
            for path, lang in external_candidates(video, subtitle, target_lang, prefs):
                try:
                    cues = read_subtitles(path, fps=info.fps).cues
                except Exception as err:  # noqa: BLE001
                    log(f"Could not read {path.name}: {err}")
                    continue
                if len(cues) < min_lines:
                    log(f"Skipping {path.name}: only {len(cues)} lines")
                    continue
                if settings.verify_external:
                    stream = pick_audio_stream(info, prefs)
                    if stream is not None:
                        check = audio_agreement(cues, speech_intervals(info, stream, settings, log), info.duration)
                        if not check["ok"]:
                            log(f"Skipping {path.name}: does not match the audio (window lags {check['lags']})")
                            continue
                log(f"Reference: external {path.name}, {len(cues)} lines")
                return Reference("external", path.name, lang, cues)

        elif source == "transcript":
            stream = pick_audio_stream(info, prefs)
            if stream is None:
                continue
            log(f"Reference: transcript of audio track #{stream.index} ({stream.language or 'auto'})")
            cues = get_transcript(info, stream, settings, log, progress)
            if len(cues) < 20:
                log(f"Transcript has only {len(cues)} lines")
                continue
            return Reference("transcript", f"transcript of audio #{stream.index}", stream.language, cues)

    raise NoReferenceError("No usable reference (no text subtitle track, external subtitles or transcript)")
