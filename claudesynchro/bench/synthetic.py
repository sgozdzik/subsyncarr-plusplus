"""Synthetic benchmark: claudesynchro vs alass on realistic EN/PL subtitle scenarios with ground truth.

Lines are real English/Polish sentence pairs (Tatoeba). A canonical "film" is a list of scenes;
the video and the Polish subtitles are each derived from it with edits, and every Polish line
knows its true video time (or that it must be dropped).
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from claudesynchro.align import align  # noqa: E402
from claudesynchro.config import Settings  # noqa: E402
from claudesynchro.embeddings import LocalEmbedder  # noqa: E402
from claudesynchro.subtitles import Cue, clean_text, read_subtitles, write_srt  # noqa: E402

DATA = Path(os.environ.get("TATOEBA_DIR", Path(__file__).parent / "data"))
ALASS = shutil.which("alass") or shutil.which("alass-cli")
GENERIC = [
    ("Yes.", "Tak."), ("No.", "Nie."), ("What?", "Co?"), ("Okay.", "Dobrze."), ("Thank you.", "Dziękuję."),
    ("Come on!", "Chodź!"), ("Let's go.", "Chodźmy."), ("Why?", "Dlaczego?"), ("I know.", "Wiem."),
    ("Hey!", "Hej!"), ("Really?", "Naprawdę?"), ("Sorry.", "Przepraszam."),
]


def load_pairs(seed: int) -> list[tuple[str, str]]:
    en = (DATA / "Tatoeba.en-pl.en").read_text(encoding="utf-8").splitlines()
    pl = (DATA / "Tatoeba.en-pl.pl").read_text(encoding="utf-8").splitlines()
    pairs = [(e, p) for e, p in zip(en, pl) if 2 <= len(e.split()) <= 14 and len(p) < 90]
    rnd = random.Random(seed)
    rnd.shuffle(pairs)
    return pairs


@dataclass
class Line:
    en: str
    pl: str
    dur: float
    gap: float  # silence before this line


def make_scenes(pairs, rnd, n_scenes, start_idx=0, size=(15, 40)):
    scenes = []
    k = start_idx
    for _ in range(n_scenes):
        lines = []
        for _ in range(rnd.randint(*size)):
            if rnd.random() < 0.08:
                en, pl = rnd.choice(GENERIC)
            else:
                en, pl = pairs[k]
                k += 1
            dur = min(6.0, 1.0 + 0.055 * len(en)) * rnd.uniform(0.85, 1.15)
            gap = rnd.uniform(0.15, 2.2) if rnd.random() < 0.85 else rnd.uniform(3, 9)
            lines.append(Line(en, pl, dur, gap))
        scenes.append(lines)
    return scenes, k


def layout(scenes, scene_gaps):
    """Assign times. Returns list of (scene_id, line_idx, start, end)."""
    t = 5.0
    out = []
    for sid, lines in scenes:
        t += scene_gaps.get(sid, 4.0)
        for li, ln in enumerate(lines):
            t += ln.gap
            out.append((sid, li, t, t + ln.dur))
            t += ln.dur
    return out


def build_case(name, pairs, seed, *, video_extra=0, subs_extra=0, ads=0, speed=1.0, offset=0.0,
               transcript=False, merge=0.1, wrong=False, extra_size=(15, 40), miss=0.25, corrupt=0.15,
               jitter=0.12, trims=0):
    rnd = random.Random(seed)
    base, k = make_scenes(pairs, rnd, 45)
    extra_v, k = make_scenes(pairs, rnd, video_extra, k, extra_size)
    extra_s, k = make_scenes(pairs, rnd, subs_extra, k, extra_size)
    canon = [(f"b{i}", s) for i, s in enumerate(base)]
    trimmed_full = {}
    vid_scenes = list(canon)
    for i, sc in enumerate(extra_v):
        pos = rnd.randint(3, len(vid_scenes) - 3)
        vid_scenes.insert(pos, (f"v{i}", sc))
    sub_scenes = list(canon)
    for i, sc in enumerate(extra_s):
        pos = rnd.randint(3, len(sub_scenes) - 3)
        sub_scenes.insert(pos, (f"s{i}", sc))
    for idx in rnd.sample(range(3, len(vid_scenes) - 3), trims):
        sid, sc = vid_scenes[idx]
        if len(sc) > 12:
            cut_at = rnd.randint(3, len(sc) - 6)
            n_cut = rnd.randint(2, 4)
            keep = [ln for j, ln in enumerate(sc) if not (cut_at <= j < cut_at + n_cut)]
            vid_scenes[idx] = (sid + "t", keep)
            # the subtitle version keeps the full scene under the trimmed id's original lines
            sub_scenes = [(sid2 + ("t" if sid2 == sid else ""), sc2) for sid2, sc2 in sub_scenes]
            trimmed_full[sid + "t"] = (sc, cut_at, n_cut)
    scene_gaps_v = {}
    ad_positions = rnd.sample(range(5, len(vid_scenes) - 2), ads) if ads else []
    for p in ad_positions:
        scene_gaps_v[vid_scenes[p][0]] = rnd.uniform(120, 240)

    vid = layout(vid_scenes, scene_gaps_v)
    sub = layout(sub_scenes, {})
    vid_time = {(sid, li): (s, e) for sid, li, s, e in vid}
    for sid, (full, cut_at, n_cut) in trimmed_full.items():
        remap = {}
        for li in range(len(full)):
            if li < cut_at:
                remap[li] = vid_time.get((sid, li))
            elif li >= cut_at + n_cut:
                remap[li] = vid_time.get((sid, li - n_cut))
            else:
                remap[li] = None
        for li, v in remap.items():
            vid_time[("SUB", sid, li)] = v
    lines_by_scene = dict(vid_scenes)
    lines_by_scene.update({sid: (trimmed_full[sid][0] if sid in trimmed_full else sc) for sid, sc in sub_scenes})
    vid_lines = dict(vid_scenes)

    # Reference: English lines on the video timeline.
    ref = [Cue(s, e, vid_lines[sid][li].en) for sid, li, s, e in vid]
    if transcript:
        vocab = [w for ln in sum((sc for _, sc in vid_scenes), []) for w in ln.en.split()]
        noisy = []
        for c in ref:
            if rnd.random() < miss:
                continue  # missed by whisper
            words = [w if rnd.random() > corrupt else rnd.choice(vocab) for w in c.text.split()]
            jit = rnd.uniform(-0.3, 0.3)
            noisy.append(Cue(c.start + jit, c.end + rnd.uniform(-0.2, 0.5), " ".join(words)))
        merged = []
        for c in noisy:
            if merged and rnd.random() < 0.3 and c.start - merged[-1].end < 1.0:
                merged[-1] = Cue(merged[-1].start, c.end, merged[-1].text + " " + c.text)
            else:
                merged.append(c)
        # ads with speech: random English chatter in ad breaks
        for p in ad_positions:
            sid = vid_scenes[p][0]
            first = next(s for s2, li, s, e in vid if s2 == sid and li == 0)
            t = first - scene_gaps_v[sid] + 5
            while t < first - 10:
                en, _ = pairs[rnd.randint(40000, 50000)]
                merged.append(Cue(t, t + 2.5, en))
                t += rnd.uniform(3, 6)
        ref = sorted(merged, key=lambda c: c.start)

    # Polish subtitles on their own timeline, then speed/offset + jitter; some lines merged.
    target, truth = [], []
    for sid, li, s, e in sub:
        ln = lines_by_scene[sid][li]
        ts = (s * speed) + offset + rnd.uniform(-jitter, jitter)
        te = (e * speed) + offset + rnd.uniform(-jitter, jitter)
        true = vid_time.get(("SUB", sid, li)) if sid in trimmed_full else vid_time.get((sid, li))
        if (target and rnd.random() < merge and ts - target[-1].end < 1.5 and sid == truth[-1][0]):
            prev = target[-1]
            target[-1] = Cue(prev.start, te, prev.text + "\n" + ln.pl)
            continue
        target.append(Cue(ts, te, ln.pl))
        truth.append((sid, true[0] if true else None))
    if wrong:  # subtitles for a different film
        other, _ = make_scenes(pairs, random.Random(seed + 99), 45, 20000)
        target = [Cue(s, e, other_line.pl) for (sid, li, s, e), other_line in zip(sub, sum(other, []))]
        truth = [("x", None) for _ in target]
    extra_regions = []
    for sid, sc in vid_scenes:
        if sid.startswith("v"):
            times = [(s, e) for s2, li, s, e in vid if s2 == sid]
            extra_regions.append((times[0][0], times[-1][1]))
    return dict(name=name, target=target, truth=truth, ref=ref, extra_regions=extra_regions, transcript=transcript)


def score(pred_start: list[float | None], truth) -> dict:
    keep_total = sum(1 for _, t in truth if t is not None)
    drop_total = len(truth) - keep_total
    ok05 = ok10 = wrongly_dropped = correctly_dropped = 0
    for p, (_, t) in zip(pred_start, truth):
        if t is None:
            correctly_dropped += p is None
            continue
        if p is None:
            wrongly_dropped += 1
            continue
        ok05 += abs(p - t) <= 0.5
        ok10 += abs(p - t) <= 1.0
    return {
        "within_0.5s": round(ok05 / max(keep_total, 1), 3),
        "within_1s": round(ok10 / max(keep_total, 1), 3),
        "wrongly_dropped": wrongly_dropped,
        "dropped_ok": f"{correctly_dropped}/{drop_total}",
    }


def run_alass(case, tmp: Path) -> dict:
    if ALASS is None:
        return {"within_0.5s": float("nan"), "dropped_ok": "-", "seconds": 0}
    ref_p, inc_p, out_p = tmp / "ref.srt", tmp / "inc.srt", tmp / "out.srt"
    write_srt(case["ref"], ref_p)
    write_srt(case["target"], inc_p)
    t0 = time.time()
    subprocess.run([ALASS, str(ref_p), str(inc_p), str(out_p)], check=True, capture_output=True)
    out = read_subtitles(out_p).cues
    assert len(out) == len(case["target"]), (len(out), len(case["target"]))
    res = score([c.start for c in out], case["truth"])
    res["seconds"] = round(time.time() - t0, 2)
    return res


def run_claude(case, embedder) -> dict:
    t0 = time.time()
    t_text = [clean_text(c.text) for c in case["target"]]
    r_text = [clean_text(c.text) for c in case["ref"]]
    et, er = embedder.embed(t_text), embedder.embed(r_text)
    try:
        al = align(case["target"], case["ref"], t_text, r_text, et, er, is_transcript=case["transcript"])
    except Exception as err:  # noqa: BLE001
        return {"error": str(err)[:80], "seconds": round(time.time() - t0, 2)}
    pred: list[float | None] = [None] * len(case["target"])
    for cue, i in zip(al.cues, al.source_index):
        pred[i] = cue.start
    res = score(pred, case["truth"])
    filled = [j for r in al.regions for j in r.reference_indices]
    inside = sum(
        1 for j in filled
        if any(lo - 1 <= case["ref"][j].start <= hi + 1 for lo, hi in case["extra_regions"])
    )
    res["filled"] = f"{inside}/{len(filled)} in extra scenes"
    res["cuts"] = len(al.cuts)
    res["speed"] = round(al.speed, 4)
    res["confidence"] = round(al.confidence, 2)
    res["seconds"] = round(time.time() - t0, 2)
    return res


CASES_HARD = [
    ("H: subs ext short scenes", dict(subs_extra=5, extra_size=(5, 10), jitter=0.3, merge=0.2)),
    ("H: video ext short scenes", dict(video_extra=5, extra_size=(5, 10), jitter=0.3, merge=0.2)),
    ("H: TV trims (2-4 lines)", dict(trims=6, jitter=0.3)),
    ("H: TRANSCRIPT noisy subs ext", dict(subs_extra=4, extra_size=(6, 14), transcript=True, miss=0.4, corrupt=0.3, jitter=0.3, merge=0.2)),
    ("H: TRANSCRIPT noisy video ext fps", dict(video_extra=4, extra_size=(6, 14), speed=23.976/25, transcript=True, miss=0.4, corrupt=0.3, jitter=0.3)),
    ("H: TRANSCRIPT very noisy mixed", dict(video_extra=2, subs_extra=2, ads=2, transcript=True, miss=0.5, corrupt=0.4, jitter=0.3, merge=0.2)),
]

CASES = [
    ("offset only", dict(offset=12.3)),
    ("fps 25→23.976 + offset", dict(speed=25 / 23.976, offset=-4.0)),
    ("4 ad breaks (silent)", dict(ads=4, offset=2.0)),
    ("video extended (+3 scenes)", dict(video_extra=3)),
    ("subs extended (+3 scenes)", dict(subs_extra=3, offset=1.5)),
    ("both + fps + ads", dict(video_extra=2, subs_extra=2, ads=2, speed=23.976 / 25, offset=3.0)),
    ("TRANSCRIPT: offset", dict(offset=7.0, transcript=True)),
    ("TRANSCRIPT: ads w/ speech", dict(ads=3, transcript=True)),
    ("TRANSCRIPT: video extended", dict(video_extra=3, transcript=True)),
    ("TRANSCRIPT: subs extended+fps", dict(subs_extra=3, speed=25 / 23.976, transcript=True)),
    ("WRONG subtitles (other film)", dict(wrong=True)),
]


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    cases = CASES_HARD if only == "hard" else CASES + CASES_HARD
    if only == "hard":
        only = None
    pairs = load_pairs(1)
    settings = Settings()
    embedder = LocalEmbedder(settings, lambda m: print(m, file=sys.stderr))
    results = []
    with tempfile.TemporaryDirectory() as td:
        for i, (name, kw) in enumerate(cases):
            if only and only.lower() not in name.lower():
                continue
            case = build_case(name, pairs, seed=int(os.environ.get("SEED_BASE", "100")) + i, **kw)
            a = run_alass(case, Path(td))
            c = run_claude(case, embedder)
            results.append({"case": name, "lines": len(case["target"]), "alass": a, "claudesynchro": c})
            print(json.dumps(results[-1], ensure_ascii=False))


if __name__ == "__main__":
    main()
