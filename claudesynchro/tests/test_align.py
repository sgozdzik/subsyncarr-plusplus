"""Alignment logic with deterministic fake embeddings (no model download needed).

Every "sentence" gets a random unit vector; the Polish and English versions of the same
sentence share it (plus noise), so similarity behaves like a real multilingual model.
"""

import numpy as np
import pytest

from claudesynchro.align import AlignmentError, align
from claudesynchro.subtitles import Cue

RNG = np.random.default_rng(7)
DIM = 64


def make_film(n_lines, rng, gap=(0.3, 2.5)):
    t = 10.0
    lines = []
    for i in range(n_lines):
        t += rng.uniform(*gap)
        dur = rng.uniform(1.2, 4.0)
        lines.append((i, t, t + dur))
        t += dur
    return lines


def vectors(ids, rng, noise=0.25):
    base = {}
    out = []
    for i in ids:
        if i not in base:
            v = np.random.default_rng(1000 + i).normal(size=DIM)
            base[i] = v / np.linalg.norm(v)
        v = base[i] + rng.normal(scale=noise / np.sqrt(DIM), size=DIM)
        out.append(v / np.linalg.norm(v))
    return np.array(out, dtype=np.float32)


def run(target_lines, ref_lines, **kw):
    target = [Cue(s, e, f"pl {i}") for i, s, e in target_lines]
    ref = [Cue(s, e, f"en {i}") for i, s, e in ref_lines]
    et = vectors([i for i, _, _ in target_lines], RNG)
    er = vectors([i for i, _, _ in ref_lines], RNG)
    return align(target, ref, [c.text for c in target], [c.text for c in ref], et, er, **kw)


def predicted(al, n):
    out = [None] * n
    for cue, i in zip(al.cues, al.source_index):
        out[i] = cue.start
    return out


def test_offset_and_framerate():
    film = make_film(300, np.random.default_rng(1))
    ref = film
    speed = 25 / 23.976
    target = [(i, s * speed + 7.0, e * speed + 7.0) for i, s, e in film]
    al = run(target, ref)
    pred = predicted(al, len(target))
    assert abs(al.speed - 23.976 / 25) < 1e-3
    assert all(abs(p - s) < 0.3 for p, (_, s, _) in zip(pred, film))
    assert al.confidence > 0.9 and not al.cuts


def test_subtitles_with_extra_scene_are_dropped():
    film = make_film(300, np.random.default_rng(2))
    # The subtitles contain lines 1000..1029 (a deleted scene) after line 150.
    extra = make_film(30, np.random.default_rng(3))
    shift = extra[-1][2] - extra[0][1] + 5
    target = []
    for i, s, e in film:
        if i == 150:
            base = s - extra[0][1] - 2 - shift
            target += [(1000 + j, s2 + base + shift - 0, e2 + base + shift) for j, s2, e2 in extra]
        target.append((i, s if i < 150 else s + shift, e if i < 150 else e + shift))
    target.sort(key=lambda x: x[1])
    al = run(target, film)
    pred = predicted(al, len(target))
    for (i, _, _), p in zip(target, pred):
        if i >= 1000:
            assert p is None, f"line {i} from the deleted scene was kept"
        else:
            assert p is not None and abs(p - film[i][1]) < 0.3
    assert len(al.cuts) == 1 and al.cuts[0].jump < 0


def test_video_with_extra_scene_reports_region():
    film = make_film(300, np.random.default_rng(4))
    extra_len = 60.0
    ref = [(i, s if i < 200 else s + extra_len, e if i < 200 else e + extra_len) for i, s, e in film]
    insert_at = film[199][2] + 2
    ref += [(2000 + k, insert_at + 5 * k, insert_at + 5 * k + 3) for k in range(10)]
    ref.sort(key=lambda x: x[1])
    al = run(film, ref)
    pred = predicted(al, len(film))
    truth = {i: s for i, s, _ in ref}
    assert all(abs(p - truth[i]) < 0.3 for p, (i, _, _) in zip(pred, film))
    assert len(al.regions) == 1 and al.regions[0].kind == "cut"
    filled_ids = {ref[j][0] for j in al.regions[0].reference_indices}
    assert filled_ids == {2000 + k for k in range(10)}


def test_wrong_subtitles_are_refused():
    film = make_film(200, np.random.default_rng(5))
    other = [(5000 + i, s, e) for i, s, e in make_film(200, np.random.default_rng(6))]
    with pytest.raises(AlignmentError):
        run(other, film)
