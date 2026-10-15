"""Reading and writing subtitle files.

Supports the formats commonly found next to movies in Poland: SubRip (.srt),
WebVTT, ASS/SSA, MicroDVD ({frame}{frame}), MPL2 ([ds][ds]) and TMPlayer
(hh:mm:ss:text), in UTF-8/UTF-16 or the legacy CP1250 / ISO-8859-2 encodings.
Everything is normalised to SRT-style display text (``\\n`` line breaks, ``<i>``
tags) and written back out as UTF-8 SRT.
"""

from __future__ import annotations

import codecs
import re
from dataclasses import dataclass
from pathlib import Path

DEFAULT_FPS = 23.976


@dataclass
class Cue:
    start: float  # seconds
    end: float  # seconds
    text: str  # display text: lines separated by "\n", SRT-style tags allowed

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class SubtitleFile:
    cues: list[Cue]
    format: str
    encoding: str


# ---------------------------------------------------------------------------
# Encoding detection
# ---------------------------------------------------------------------------

_POLISH_LETTERS = set("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ")
# Characters that show up when CP1250 bytes are decoded as ISO-8859-2 or vice versa.
_MOJIBAKE = set("±¶¼¦¬ˇšŠťŤľĽ") | {chr(c) for c in range(0x80, 0xA0)}


def decode_bytes(data: bytes) -> tuple[str, str]:
    """Decode subtitle bytes, preferring UTF-8 and then the Central-European code pages."""
    if data.startswith(codecs.BOM_UTF8):
        return data[len(codecs.BOM_UTF8) :].decode("utf-8", errors="replace"), "utf-8-sig"
    if data.startswith(codecs.BOM_UTF16_LE) or data.startswith(codecs.BOM_UTF16_BE):
        return data.decode("utf-16", errors="replace"), "utf-16"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass

    best: tuple[int, str, str] | None = None
    for enc in ("cp1250", "iso-8859-2"):
        try:
            text = data.decode(enc)
        except UnicodeDecodeError:
            continue
        polish = sum(1 for ch in text if ch in _POLISH_LETTERS)
        bad = sum(1 for ch in text if ch in _MOJIBAKE)
        score = polish - 5 * bad
        if polish > 0 and (best is None or score > best[0]):
            best = (score, text, enc)
    if best is not None and best[0] > 0:
        return best[1], best[2]

    try:
        from charset_normalizer import from_bytes

        match = from_bytes(data).best()
        if match is not None:
            return str(match), match.encoding
    except ImportError:  # pragma: no cover - dependency is declared
        pass
    return data.decode("cp1252", errors="replace"), "cp1252"


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

_TIMING_RE = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.:](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.:](\d{1,3})"
)
_MICRODVD_RE = re.compile(r"^\{(\d+)\}\{(\d*)\}(.*)$")
_MPL2_RE = re.compile(r"^\[(\d+)\]\[(\d*)\](.*)$")
_TMPLAYER_RE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})(?:[,.]\d+)?[:=](.*)$")


def _ts(h: str | None, m: str, s: str, ms: str) -> float:
    frac = int(ms) / (10 ** len(ms))
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + frac


def _parse_timed_blocks(text: str) -> list[Cue]:
    """SubRip and WebVTT: a timing line followed by text lines."""
    cues: list[Cue] = []
    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        m = _TIMING_RE.search(lines[i])
        if not m:
            i += 1
            continue
        start = _ts(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _ts(m.group(5), m.group(6), m.group(7), m.group(8))
        i += 1
        body: list[str] = []
        while i < n and lines[i].strip() != "":
            # Tolerate files without blank separators: "<index>\n<timing>" starts a new cue.
            if _TIMING_RE.search(lines[i]):
                if body and body[-1].strip().isdigit():
                    body.pop()
                break
            body.append(lines[i].rstrip())
            i += 1
        cues.append(Cue(start, end, "\n".join(body).strip()))
    return cues


_ASS_TAG_RE = re.compile(r"\{[^}]*\}")


def _ass_text(raw: str) -> str:
    t = raw.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    t = re.sub(r"\{\\i1\}", "<i>", t)
    t = re.sub(r"\{\\i0?\}", "</i>", t)
    t = re.sub(r"\{\\b1\}", "<b>", t)
    t = re.sub(r"\{\\b0?\}", "</b>", t)
    t = _ASS_TAG_RE.sub("", t)
    return t.strip()


def _parse_ass(text: str) -> list[Cue]:
    cues: list[Cue] = []
    fields: list[str] | None = None
    in_events = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_events = stripped.lower() == "[events]"
            continue
        if not in_events:
            continue
        if stripped.lower().startswith("format:"):
            fields = [f.strip().lower() for f in stripped[7:].split(",")]
            continue
        if not stripped.lower().startswith("dialogue:") or fields is None:
            continue
        parts = stripped[9:].split(",", len(fields) - 1)
        if len(parts) < len(fields):
            continue
        rec = dict(zip(fields, parts))
        try:
            start = _ass_time(rec["start"])
            end = _ass_time(rec["end"])
        except (KeyError, ValueError):
            continue
        body = _ass_text(rec.get("text", ""))
        if body:
            cues.append(Cue(start, end, body))
    cues.sort(key=lambda c: c.start)
    return cues


def _ass_time(value: str) -> float:
    h, m, s = value.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _slash_italics(line: str) -> str:
    line = line.strip()
    if line.startswith("/"):
        return f"<i>{line[1:].strip()}</i>"
    return line


def _microdvd_text(raw: str) -> str:
    whole_italic = bool(re.search(r"\{Y:i\}", raw))
    lines = []
    for part in raw.split("|"):
        italic = bool(re.search(r"\{y:i\}", part, re.IGNORECASE))
        part = _ASS_TAG_RE.sub("", part)
        part = _slash_italics(part)
        if italic and not whole_italic and not part.startswith("<i>"):
            part = f"<i>{part}</i>"
        lines.append(part)
    body = "\n".join(lines).strip()
    if whole_italic:
        body = f"<i>{body}</i>"
    return body


def _parse_microdvd(text: str, fps: float | None) -> list[Cue]:
    rows = []
    for line in text.splitlines():
        m = _MICRODVD_RE.match(line.strip())
        if m:
            rows.append((int(m.group(1)), int(m.group(2)) if m.group(2) else None, m.group(3)))
    # Convention: a first line "{1}{1}23.976" declares the frame rate.
    if rows and rows[0][0] in (0, 1) and re.fullmatch(r"\d+(?:[.,]\d+)?", rows[0][2].strip()):
        declared = float(rows[0][2].strip().replace(",", "."))
        if 10 < declared < 121:
            fps = declared
        rows = rows[1:]
    fps = fps or DEFAULT_FPS
    cues = []
    for i, (sf, ef, body) in enumerate(rows):
        start = sf / fps
        if ef is None:
            nxt = rows[i + 1][0] / fps if i + 1 < len(rows) else start + 3
            end = min(start + 5, nxt)
        else:
            end = ef / fps
        cues.append(Cue(start, end, _microdvd_text(body)))
    return cues


def _parse_mpl2(text: str) -> list[Cue]:
    rows = []
    for line in text.splitlines():
        m = _MPL2_RE.match(line.strip())
        if m:
            rows.append((int(m.group(1)), int(m.group(2)) if m.group(2) else None, m.group(3)))
    cues = []
    for i, (s, e, body) in enumerate(rows):
        start = s / 10
        if e is None:
            nxt = rows[i + 1][0] / 10 if i + 1 < len(rows) else start + 3
            end = min(start + 5, nxt)
        else:
            end = e / 10
        text_lines = [_slash_italics(_ASS_TAG_RE.sub("", p)) for p in body.split("|")]
        cues.append(Cue(start, end, "\n".join(text_lines).strip()))
    return cues


def _parse_tmplayer(text: str) -> list[Cue]:
    rows = []
    for line in text.splitlines():
        m = _TMPLAYER_RE.match(line.strip())
        if m:
            start = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
            rows.append((float(start), m.group(4)))
    cues = []
    for i, (start, body) in enumerate(rows):
        text_lines = [_slash_italics(p) for p in body.split("|")]
        words = len(body.split())
        end = start + min(6.0, max(1.5, 0.35 * words + 0.8))
        if i + 1 < len(rows):
            end = min(end, rows[i + 1][0] - 0.05)
        cues.append(Cue(start, max(end, start + 0.5), "\n".join(text_lines).strip()))
    return cues


def detect_format(text: str) -> str:
    head = text.lstrip()[:4096]
    if head.startswith("WEBVTT"):
        return "vtt"
    if "[Script Info]" in head or re.search(r"^\s*Dialogue:", text[:20000], re.MULTILINE):
        return "ass"
    if _TIMING_RE.search(head):
        return "srt"
    first_lines = [ln.strip() for ln in head.splitlines() if ln.strip()][:10]
    if sum(1 for ln in first_lines if _MICRODVD_RE.match(ln)) >= max(1, len(first_lines) // 2):
        return "microdvd"
    if sum(1 for ln in first_lines if _MPL2_RE.match(ln)) >= max(1, len(first_lines) // 2):
        return "mpl2"
    if sum(1 for ln in first_lines if _TMPLAYER_RE.match(ln)) >= max(1, len(first_lines) // 2):
        return "tmplayer"
    if _TIMING_RE.search(text[:200000]):
        return "srt"
    return "unknown"


def parse_subtitles(text: str, fps: float | None = None) -> tuple[list[Cue], str]:
    fmt = detect_format(text)
    if fmt in ("srt", "vtt"):
        cues = _parse_timed_blocks(text)
    elif fmt == "ass":
        cues = _parse_ass(text)
    elif fmt == "microdvd":
        cues = _parse_microdvd(text, fps)
    elif fmt == "mpl2":
        cues = _parse_mpl2(text)
    elif fmt == "tmplayer":
        cues = _parse_tmplayer(text)
    else:
        raise ValueError("Unrecognised subtitle format")
    cues = [c for c in cues if c.text.strip() and c.end >= c.start]
    cues.sort(key=lambda c: (c.start, c.end))
    return cues, fmt


def read_subtitles(path: str | Path, fps: float | None = None) -> SubtitleFile:
    data = Path(path).read_bytes()
    text, encoding = decode_bytes(data)
    cues, fmt = parse_subtitles(text, fps)
    return SubtitleFile(cues=cues, format=fmt, encoding=encoding)


def looks_like_subtitles(path: str | Path) -> bool:
    """Cheap sniff used for ambiguous extensions such as .txt."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192)
    except OSError:
        return False
    text, _ = decode_bytes(head)
    return detect_format(text) != "unknown"


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def format_srt_time(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms_total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(cues: list[Cue]) -> str:
    out = []
    for i, cue in enumerate(cues, 1):
        end = max(cue.end, cue.start + 0.04)
        out.append(f"{i}\n{format_srt_time(cue.start)} --> {format_srt_time(end)}\n{cue.text.strip()}\n")
    return "\n".join(out)


def write_srt(cues: list[Cue], path: str | Path) -> None:
    Path(path).write_text(to_srt(cues), encoding="utf-8")


# ---------------------------------------------------------------------------
# Text normalisation for matching
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>|\{[^}]*\}")
_SPEAKER_RE = re.compile(r"^[A-ZĄĆĘŁŃÓŚŹŻ][A-ZĄĆĘŁŃÓŚŹŻ0-9 .'\-]{1,25}:\s+")
_SOUND_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)")
_LETTER_RE = re.compile(r"[^\W\d_]")


def clean_text(text: str) -> str:
    """Text used for semantic matching: no tags, dashes, speaker labels or SDH sound notes."""
    t = _TAG_RE.sub(" ", text)
    parts = []
    for line in t.split("\n"):
        line = line.strip()
        line = re.sub(r"^[-–—]+\s*", "", line)
        line = _SPEAKER_RE.sub("", line)
        parts.append(line)
    t = " ".join(parts)
    t = _SOUND_RE.sub(" ", t)
    t = re.sub(r"[♪♫#*]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t if _LETTER_RE.search(t) else ""


def is_lyrics(text: str) -> bool:
    return "♪" in text or "♫" in text
