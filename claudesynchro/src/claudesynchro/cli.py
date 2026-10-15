"""Command line entry point.

    claudesynchro sync --video Movie.mkv --subtitle Movie.pl.srt [--output out.srt] [--json]
    claudesynchro probe --video Movie.mkv
    claudesynchro transcribe --video Movie.mkv --output Movie.transcript.srt
    claudesynchro doctor [--json]

Exit codes for `sync`: 0 written, 2 not written (low confidence), 3 skipped, 1 error.
With --json the last stdout line is a JSON object with status, message, output and report.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from .config import Settings


def _log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def _apply_overrides(settings: Settings, args: argparse.Namespace) -> None:
    if getattr(args, "reference", None):
        settings.reference_order = [p.strip() for p in args.reference.split(",")]
    if getattr(args, "gap_fill", None):
        settings.gap_fill = args.gap_fill
    if getattr(args, "min_confidence", None) is not None:
        settings.min_confidence = args.min_confidence
    if getattr(args, "whisper_model", None):
        settings.whisper_model = args.whisper_model
    if getattr(args, "languages", None):
        settings.languages = [p.strip().lower() for p in args.languages.split(",")]


def cmd_sync(args: argparse.Namespace) -> int:
    from .sync import Outcome, run

    settings = Settings()
    _apply_overrides(settings, args)
    try:
        outcome = run(
            Path(args.video),
            Path(args.subtitle),
            Path(args.output) if args.output else None,
            settings,
            _log,
            reference_file=Path(args.reference_file) if args.reference_file else None,
            check_language=not args.any_language,
        )
    except Exception as err:  # noqa: BLE001 - reported to the caller as JSON
        _log(traceback.format_exc())
        outcome = Outcome("error", f"{type(err).__name__}: {err}")
    _log(f"{outcome.status}: {outcome.message}")
    if args.json:
        print(
            json.dumps(
                {
                    "status": outcome.status,
                    "message": outcome.message,
                    "output": outcome.output,
                    "confidence": outcome.confidence,
                    "report": outcome.report,
                },
                ensure_ascii=False,
            )
        )
    return outcome.exit_code


def cmd_probe(args: argparse.Namespace) -> int:
    from .media import probe
    from .references import embedded_candidates

    settings = Settings()
    info = probe(args.video)
    print(f"duration {info.duration:.1f}s, fps {info.fps}")
    for s in info.streams:
        flags = ",".join(f for f, on in (("default", s.default), ("forced", s.forced), ("sdh", s.hearing_impaired)) if on)
        print(f"  #{s.index} {s.type:8} {s.codec:10} {s.language or 'und':4} {flags:20} {s.title}")
    ranked = embedded_candidates(info, None, settings.reference_languages)
    print("embedded reference candidates:", [s.index for s in ranked] or "none")
    return 0


def cmd_transcribe(args: argparse.Namespace) -> int:
    from .media import pick_audio_stream, probe
    from .subtitles import write_srt
    from .transcribe import get_transcript

    settings = Settings()
    _apply_overrides(settings, args)
    info = probe(args.video)
    stream = pick_audio_stream(info, settings.reference_languages)
    if stream is None:
        _log("No audio stream")
        return 1
    cues = get_transcript(info, stream, settings, _log, lambda f: _log(f"{f:.0%}"))
    write_srt(cues, args.output)
    _log(f"Wrote {len(cues)} lines to {args.output}")
    return 0


def _dir_size(path: Path) -> int:
    try:
        # Hugging Face caches link snapshots to blobs; count real files only.
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file() and not f.is_symlink())
    except OSError:
        return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Environment check for the Diagnostics page: versions, CPU support, caches, settings."""
    import dataclasses
    import importlib.metadata
    import os
    import platform
    import shutil

    from . import __version__

    settings = Settings()
    info: dict = {
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "threads": settings.cpu_threads,
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
    }
    packages = {}
    for name in ("numpy", "onnxruntime", "ctranslate2", "faster-whisper", "tokenizers", "huggingface-hub", "av"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    info["packages"] = packages
    try:
        import ctranslate2

        info["whisper_cpu_compute_types"] = sorted(ctranslate2.get_supported_compute_types("cpu"))
    except Exception as err:  # noqa: BLE001 - reported, not fatal
        info["whisper_cpu_compute_types"] = f"error: {err}"
    try:
        import onnxruntime

        info["onnxruntime_providers"] = onnxruntime.get_available_providers()
    except Exception as err:  # noqa: BLE001
        info["onnxruntime_providers"] = f"error: {err}"

    data = settings.data_dir
    writable = False
    try:
        data.mkdir(parents=True, exist_ok=True)
        probe_file = data / ".write-test"
        probe_file.write_text("ok")
        probe_file.unlink()
        writable = True
    except OSError:
        pass
    info["data_dir"] = {
        "path": str(data),
        "writable": writable,
        "models_mb": round(_dir_size(settings.models_dir) / 1e6, 1),
        "whisper_models": sorted(p.name for p in (settings.models_dir / "whisper").glob("models--*")),
        "transcripts_cached": len(list((settings.cache_dir / "transcripts").glob("*.json"))),
        "reports": len(list(settings.reports_dir.glob("*.json"))),
    }
    effective = {k: (str(v) if isinstance(v, Path) else v) for k, v in dataclasses.asdict(settings).items()}
    if effective.get("openrouter_api_key"):
        effective["openrouter_api_key"] = "***" + str(effective["openrouter_api_key"])[-4:]
    info["settings"] = effective

    if args.json:
        print(json.dumps(info))
    else:
        print(json.dumps(info, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="claudesynchro", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("sync", help="synchronise a subtitle file to a video")
    p.add_argument("--video", required=True)
    p.add_argument("--subtitle", required=True)
    p.add_argument("--output")
    p.add_argument("--reference-file", help="use this subtitle file as the reference timeline")
    p.add_argument("--reference", help="reference sources in order, e.g. embedded,external,transcript")
    p.add_argument("--gap-fill", choices=["none", "english", "translate"])
    p.add_argument("--min-confidence", type=float)
    p.add_argument("--whisper-model")
    p.add_argument("--languages", help="subtitle languages to sync, e.g. pl")
    p.add_argument("--any-language", action="store_true", help="do not check the subtitle language")
    p.add_argument("--json", action="store_true", help="print a JSON result as the last stdout line")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("probe", help="list streams and reference candidates")
    p.add_argument("--video", required=True)
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("transcribe", help="write the speech transcript of a video as SRT")
    p.add_argument("--video", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--whisper-model")
    p.set_defaults(func=cmd_transcribe)

    p = sub.add_parser("doctor", help="check versions, CPU support, caches and settings")
    p.add_argument("--json", action="store_true", help="single-line JSON")
    p.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
