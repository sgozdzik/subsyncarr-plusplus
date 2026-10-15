"""ffmpeg integration: a tiny MKV with an embedded English track becomes the reference."""

import shutil
import subprocess

import pytest

from claudesynchro.config import Settings
from claudesynchro.media import probe
from claudesynchro.references import audio_agreement, choose_reference
from claudesynchro.subtitles import Cue, write_srt

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture()
def movie(tmp_path):
    en = [Cue(1 + 2 * i, 2.5 + 2 * i, f"English line number {i}") for i in range(30)]
    srt = tmp_path / "en.srt"
    write_srt(en, srt)
    video = tmp_path / "Film (2020).mkv"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=25:d=65",
            "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-i", str(srt), "-t", "65",
            "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-preset", "ultrafast",
            "-c:a", "aac", "-c:s", "srt", "-metadata:s:s:0", "language=eng",
            "-disposition:s:0", "default", str(video),
        ],
        check=True,
    )
    return video


def test_probe_and_embedded_reference(movie, tmp_path):
    info = probe(movie)
    assert info.fps == 25 and 64 < info.duration < 66
    assert [s.type for s in info.streams] == ["video", "audio", "subtitle"]
    pl = tmp_path / "Film (2020).pl.srt"
    target = [Cue(1, 2, "linia")] * 30
    settings = Settings()
    settings.data_dir = tmp_path / "data"
    ref = choose_reference(info, movie, pl, target, "pl", settings, lambda m: None)
    assert ref.kind == "embedded" and ref.language == "en" and len(ref.cues) == 30


def test_audio_agreement_detects_shifted_reference():
    speech = [(10 + 3 * i, 11.5 + 3 * i) for i in range(400)]
    good = [Cue(s, e, "x") for s, e in speech]
    shifted = [Cue(s + 4, e + 4, "x") for s, e in speech]
    assert audio_agreement(good, speech, 1300)["ok"]
    assert not audio_agreement(shifted, speech, 1300)["ok"]
