"""Command line entry point.

    claudesynchro sync --video Movie.mkv --subtitle Movie.pl.srt [--output out.srt] [--json]
    claudesynchro probe --video Movie.mkv
    claudesynchro transcribe --video Movie.mkv --output Movie.transcript.srt

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

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
