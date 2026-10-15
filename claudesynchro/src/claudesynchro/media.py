"""ffprobe / ffmpeg helpers: stream listing, embedded subtitle extraction, PCM audio streaming."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .language import normalize_lang

SAMPLE_RATE = 16000
TEXT_SUBTITLE_CODECS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"}


@dataclass
class Stream:
    index: int
    type: str
    codec: str
    language: str | None
    title: str
    forced: bool
    default: bool
    hearing_impaired: bool
    frames: int | None = None


@dataclass
class MediaInfo:
    path: str
    duration: float
    fps: float | None
    streams: list[Stream]

    def of_type(self, kind: str) -> list[Stream]:
        return [s for s in self.streams if s.type == kind]


def _fps(value: str | None) -> float | None:
    if not value or value in ("0/0", "0"):
        return None
    try:
        if "/" in value:
            num, den = value.split("/")
            return float(num) / float(den) if float(den) else None
        return float(value)
    except ValueError:
        return None


def probe(path: str | Path) -> MediaInfo:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        check=True,
        capture_output=True,
    ).stdout
    data = json.loads(out)
    streams = []
    fps = None
    for s in data.get("streams", []):
        tags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}
        disp = s.get("disposition") or {}
        kind = s.get("codec_type", "")
        title = tags.get("title", "") or ""
        frames = tags.get("number_of_frames") or tags.get("number_of_frames-eng") or s.get("nb_frames")
        streams.append(
            Stream(
                index=int(s["index"]),
                type=kind,
                codec=s.get("codec_name", "") or "",
                language=normalize_lang(tags.get("language")),
                title=title,
                forced=bool(disp.get("forced")) or "forced" in title.lower(),
                default=bool(disp.get("default")),
                hearing_impaired=bool(disp.get("hearing_impaired")) or "sdh" in title.lower(),
                frames=int(frames) if frames and str(frames).isdigit() else None,
            )
        )
        if kind == "video" and fps is None and not disp.get("attached_pic"):
            fps = _fps(s.get("avg_frame_rate")) or _fps(s.get("r_frame_rate"))
    duration = float((data.get("format") or {}).get("duration") or 0.0)
    return MediaInfo(path=str(path), duration=duration, fps=fps, streams=streams)


def extract_subtitle_stream(path: str | Path, stream_index: int) -> str:
    """Convert one embedded text subtitle stream to SRT text."""
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
            "-map", f"0:{stream_index}", "-c:s", "srt", "-f", "srt", "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


class PcmReader:
    """Streams one audio track as 16 kHz mono float32, chunk by chunk, without temp files."""

    def __init__(self, path: str | Path, stream_index: int, start: float = 0.0, duration: float | None = None):
        cmd = ["ffmpeg", "-nostdin", "-v", "error"]
        if start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += ["-i", str(path)]
        if duration is not None:
            cmd += ["-t", f"{duration:.3f}"]
        cmd += ["-map", f"0:{stream_index}", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1"]
        # stderr is discarded: a damaged file can print enough errors to fill the pipe and block ffmpeg.
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def read(self, seconds: float) -> np.ndarray:
        assert self._proc.stdout is not None
        want = int(seconds * SAMPLE_RATE) * 2
        buf = bytearray()
        while len(buf) < want:
            chunk = self._proc.stdout.read(want - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        if len(buf) % 2:
            buf = buf[:-1]
        return np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.kill()
        self._proc.wait()

    def __enter__(self) -> "PcmReader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def encode_audio_clip(path: str | Path, stream_index: int, start: float, duration: float) -> bytes:
    """Small mono MP3 of one stretch of audio, for cloud transcription."""
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-i", str(path), "-t", f"{duration:.3f}",
            "-map", f"0:{stream_index}", "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "48k", "-f", "mp3", "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def pick_audio_stream(info: MediaInfo, preferred_languages: list[str]) -> Stream | None:
    audio = info.of_type("audio")
    if not audio:
        return None
    for lang in preferred_languages:
        if lang == "*":
            break
        for s in audio:
            if s.language == lang:
                return s
    defaults = [s for s in audio if s.default]
    return defaults[0] if defaults else audio[0]
