"""Speech-to-text reference: local faster-whisper (streamed in chunks) or OpenRouter, with a disk cache.

Also provides speech activity (VAD) intervals, used to check external reference subtitles.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Callable

import numpy as np

from .config import Settings
from .media import SAMPLE_RATE, MediaInfo, PcmReader, Stream, encode_audio_clip
from .openrouter import OpenRouterError, post_json
from .subtitles import Cue

Log = Callable[[str], None]

CHUNK_SECONDS = 20 * 60
OVERLAP_SECONDS = 6.0
_HALLUCINATIONS = re.compile(
    r"(thank(s| you) for watching|subtitles? by|amara\.org|subscribe to|napisy (stworzone|wykonane)|www\.)",
    re.IGNORECASE,
)


def _cache_key(info: MediaInfo, stream: Stream, flavour: str) -> str:
    st = os.stat(info.path)
    raw = f"{os.path.abspath(info.path)}|{st.st_size}|{int(st.st_mtime)}|{stream.index}|{flavour}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _load_cache(path: Path) -> list[Cue] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return [Cue(c[0], c[1], c[2]) for c in data["cues"]]
    except (OSError, ValueError, KeyError, IndexError):
        return None


def _save_cache(path: Path, cues: list[Cue], meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"meta": meta, "cues": [[c.start, c.end, c.text] for c in cues]}), encoding="utf-8")
    tmp.replace(path)


def _split_segment(words, fallback: tuple[float, float, str]) -> list[Cue]:
    """Split a whisper segment into sentence-sized cues using word timestamps."""
    if not words:
        s, e, t = fallback
        return [Cue(s, e, t.strip())]
    cues: list[Cue] = []
    cur: list = []
    for i, w in enumerate(words):
        if cur and w.start - cur[-1].end > 1.0:
            cues.append(Cue(cur[0].start, cur[-1].end, "".join(x.word for x in cur).strip()))
            cur = []
        cur.append(w)
        ends_sentence = w.word.strip().endswith((".", "?", "!", "…"))
        if ends_sentence and len(cur) >= 2 and i + 1 < len(words):
            cues.append(Cue(cur[0].start, cur[-1].end, "".join(x.word for x in cur).strip()))
            cur = []
    if cur:
        cues.append(Cue(cur[0].start, cur[-1].end, "".join(x.word for x in cur).strip()))
    return [c for c in cues if c.text]


def _filter_hallucinations(cues: list[Cue]) -> list[Cue]:
    out: list[Cue] = []
    repeat = 0
    for c in cues:
        if _HALLUCINATIONS.search(c.text):
            continue
        if out and c.text.lower() == out[-1].text.lower():
            repeat += 1
            if repeat >= 2:
                continue
        else:
            repeat = 0
        out.append(c)
    return out


def transcribe_local(
    info: MediaInfo, stream: Stream, settings: Settings, log: Log, progress: Callable[[float], None] | None = None
) -> list[Cue]:
    from faster_whisper import WhisperModel
    from faster_whisper.vad import get_speech_timestamps

    from .downloads import whisper_model

    log(f"Loading Whisper model '{settings.whisper_model}' ({settings.whisper_compute_type}, {settings.cpu_threads} threads)")
    model_path = whisper_model(settings.whisper_model, settings.models_dir / "whisper")
    try:
        model = WhisperModel(
            model_path,
            device="cpu",
            compute_type=settings.whisper_compute_type,
            cpu_threads=settings.cpu_threads,
        )
    except ValueError as err:
        # Older NAS CPUs (no AVX2) may not support int8; let CTranslate2 pick what works.
        log(f"Compute type {settings.whisper_compute_type} not supported ({err}); using the default")
        model = WhisperModel(
            model_path,
            device="cpu",
            compute_type="default",
            cpu_threads=settings.cpu_threads,
        )
    language = stream.language
    cues: list[Cue] = []
    speech: list[tuple[float, float]] = []
    chunk_start = 0.0  # absolute time of the first sample in `carry`
    carry = np.zeros(0, dtype=np.float32)
    with PcmReader(info.path, stream.index) as reader:
        while True:
            fresh = reader.read(CHUNK_SECONDS)
            last = len(fresh) < int(CHUNK_SECONDS * SAMPLE_RATE)
            audio = np.concatenate([carry, fresh]) if len(carry) else fresh
            if len(audio) < SAMPLE_RATE // 2:
                break
            chunk_end = chunk_start + len(audio) / SAMPLE_RATE
            keep_before = chunk_end if last else chunk_end - OVERLAP_SECONDS
            # Speech regions come almost for free while the audio is in memory; they tell the
            # aligner where people talk even when Whisper missed the words.
            for ts in get_speech_timestamps(audio, _vad_options()):
                a = chunk_start + ts["start"] / SAMPLE_RATE
                b = min(chunk_start + ts["end"] / SAMPLE_RATE, keep_before)
                if speech and a <= speech[-1][1]:  # overlap between chunks
                    speech[-1] = (speech[-1][0], max(speech[-1][1], b))
                elif b > a:
                    speech.append((a, b))
            segments, seg_info = model.transcribe(
                audio,
                language=language,
                beam_size=settings.whisper_beam_size,
                vad_filter=True,
                word_timestamps=True,
                condition_on_previous_text=False,
            )
            language = language or seg_info.language
            last_kept_end = chunk_start
            for seg in segments:
                start = chunk_start + seg.start
                if start >= keep_before:
                    break
                if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                    continue
                words = list(seg.words or [])
                for w in words:
                    w.start += chunk_start
                    w.end += chunk_start
                for cue in _split_segment(words, (start, chunk_start + seg.end, seg.text)):
                    cues.append(cue)
                    last_kept_end = max(last_kept_end, cue.end)
            if progress and info.duration:
                progress(min(1.0, keep_before / info.duration))
            if last:
                break
            # The next chunk starts where we stopped keeping segments (never later than the audio we hold).
            next_start = min(chunk_end - 1.0, max(keep_before, last_kept_end))
            carry = audio[int((next_start - chunk_start) * SAMPLE_RATE) :]
            chunk_start = next_start
    _save_speech(settings, info, stream, speech)
    return _filter_hallucinations(cues)


def transcribe_openrouter(
    info: MediaInfo, stream: Stream, settings: Settings, log: Log, progress: Callable[[float], None] | None = None
) -> list[Cue]:
    clip = 300.0
    cues: list[Cue] = []
    t = 0.0
    total = info.duration or 0.0
    log(f"Transcribing with OpenRouter ({settings.openrouter_transcribe_model}) in {int(clip)} s clips")
    while total == 0.0 or t < total:
        audio = encode_audio_clip(info.path, stream.index, t, clip)
        if len(audio) < 2000:
            break
        payload = {
            "model": settings.openrouter_transcribe_model,
            "input_audio": {"data": base64.b64encode(audio).decode("ascii"), "format": "mp3"},
            "response_format": "verbose_json",
            "timestamp_granularities": ["segment"],
        }
        if stream.language:
            payload["language"] = stream.language
        data = post_json(settings, "/audio/transcriptions", payload, timeout=120)
        segments = data.get("segments")
        if segments is None:
            raise OpenRouterError(
                f"{settings.openrouter_transcribe_model} returned no segment timestamps; choose a Whisper model"
            )
        for seg in segments:
            text = (seg.get("text") or "").strip()
            if text:
                cues.append(Cue(t + float(seg["start"]), t + float(seg["end"]), text))
        t += clip
        if progress and total:
            progress(min(1.0, t / total))
    return _filter_hallucinations(cues)


def get_transcript(
    info: MediaInfo, stream: Stream, settings: Settings, log: Log, progress: Callable[[float], None] | None = None
) -> list[Cue]:
    if settings.transcriber == "openrouter":
        flavour = f"openrouter:{settings.openrouter_transcribe_model}"
    else:
        flavour = f"local:{settings.whisper_model}:{settings.whisper_compute_type}"
    cache_path = settings.cache_dir / "transcripts" / f"{_cache_key(info, stream, flavour)}.json"
    cached = _load_cache(cache_path)
    if cached is not None:
        log(f"Using cached transcript ({len(cached)} lines)")
        return cached
    if settings.transcriber == "openrouter":
        cues = transcribe_openrouter(info, stream, settings, log, progress)
    else:
        cues = transcribe_local(info, stream, settings, log, progress)
    _save_cache(cache_path, cues, {"video": info.path, "stream": stream.index, "flavour": flavour})
    return cues


def _vad_options():
    from faster_whisper.vad import VadOptions

    return VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)


def _speech_cache(settings: Settings, info: MediaInfo, stream: Stream) -> Path:
    return settings.cache_dir / "vad" / f"{_cache_key(info, stream, 'silero')}.json"


def _save_speech(settings: Settings, info: MediaInfo, stream: Stream, intervals: list[tuple[float, float]]) -> None:
    path = _speech_cache(settings, info, stream)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(intervals))


def speech_intervals(info: MediaInfo, stream: Stream, settings: Settings, log: Log) -> list[tuple[float, float]]:
    """Speech regions of an audio track (Silero VAD bundled with faster-whisper), cached per file."""
    from faster_whisper.vad import get_speech_timestamps

    try:
        return [tuple(x) for x in json.loads(_speech_cache(settings, info, stream).read_text())]  # type: ignore[misc]
    except (OSError, ValueError):
        pass
    log("Detecting speech in the audio track")
    options = _vad_options()
    intervals: list[tuple[float, float]] = []
    offset = 0.0
    with PcmReader(info.path, stream.index) as reader:
        while True:
            audio = reader.read(600)
            if len(audio) < SAMPLE_RATE:
                break
            for ts in get_speech_timestamps(audio, options):
                intervals.append((offset + ts["start"] / SAMPLE_RATE, offset + ts["end"] / SAMPLE_RATE))
            offset += len(audio) / SAMPLE_RATE
    _save_speech(settings, info, stream, intervals)
    return intervals
