"""Content-aware alignment of a subtitle file to a reference timeline.

The reference is a list of timed lines that is known to match the video: an embedded
subtitle track, a verified external subtitle file or a speech transcript. Every target
line is compared with every reference line by meaning (multilingual embeddings), so a
Polish line can be matched with its English counterpart.

1. Candidate anchors: for each line, its most similar lines on the other side, scored by
   similarity and "margin" (how much better than its other neighbours), so generic lines
   such as "Yes." count for little.
2. Best chain: a dynamic programme picks the highest-scoring chain of anchors that is
   monotonic in both files. Consecutive anchors with the same time offset cost nothing;
   a change of offset (a cut, ad break or extended scene) costs a fixed penalty. This is
   run for each common frame-rate ratio and the best speed wins.
3. Segments: the chain is split wherever the offset jumps; each segment gets a robust
   offset. Weak segments made of a few stray anchors are discarded.
4. Gaps between segments: the lines between two segments are split into "belongs to
   the segment before", "not in this video" (dropped) and "belongs to the segment after",
   choosing the split that best agrees with the reference around each line.
5. Uncovered regions: where the video has material the subtitles lack, the reference
   lines there are reported so they can be filled in.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from .subtitles import Cue


class AlignmentError(RuntimeError):
    pass


@dataclass
class AlignParams:
    speeds: tuple[float, ...] = (
        1.0, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25, 29.97 / 25, 25 / 29.97,
    )
    min_sim: float = 0.35
    topk: int = 5
    knn: int = 4
    tol: float = 1.2
    cut_penalty: float = 2.5
    min_segment_weight: float = 1.5
    min_segment_anchors: int = 3
    local_window: float = 1.2
    evidence_threshold: float = 0.42
    drop_penalty: float = 0.12
    max_anchors: int = 9000

    @classmethod
    def for_reference(cls, is_transcript: bool) -> "AlignParams":
        if is_transcript:
            return cls(tol=1.8, local_window=4.0, evidence_threshold=0.38)
        return cls()


@dataclass
class Segment:
    anchors: list[tuple[int, int]]  # (target index, reference index), ascending
    weight: float
    offset: float = 0.0
    mad: float = 0.0

    @property
    def first(self) -> int:
        return self.anchors[0][0]

    @property
    def last(self) -> int:
        return self.anchors[-1][0]


@dataclass
class Cut:
    subtitle_time: float  # where the cut is in the original subtitle timeline
    video_time: float  # where it lands in the video
    jump: float  # >0: the video has extra material here; <0: the subtitles have extra lines
    dropped: int = 0


@dataclass
class Region:
    """A stretch of the video without (kept) subtitle lines but with reference lines."""

    start: float
    end: float
    reference_indices: list[int]
    kind: str  # "cut" or "edge"


@dataclass
class Alignment:
    speed: float
    segments: list[Segment]
    assignment: list[int | None]  # segment index per target cue, None = dropped
    cues: list[Cue]  # mapped output cues (dropped ones removed), sorted
    source_index: list[int]  # target index for every output cue
    verified: list[bool]  # per target cue
    cuts: list[Cut]
    regions: list[Region]
    confidence: float
    stats: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Similarity
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"\d+")
_WORD_RE = re.compile(r"[^\W\d_]{3,}")
_NAME_STOP = {"i'm", "i'll", "i've", "i'd", "okay", "mrs", "mister", "sir", "god", "pan", "pani", "the"}


def _numbers(text: str) -> set[str]:
    return set(_NUM_RE.findall(text))


def _names(text: str) -> set[str]:
    """Capitalised words that do not start a sentence: mostly names. Keyed by their first
    three letters so that Polish declension (Anna/Anny, John/Johna) still matches."""
    keys = set()
    for m in _WORD_RE.finditer(text):
        word = m.group(0)
        if not word[0].isupper():
            continue
        before = text[: m.start()].rstrip()
        if not before or before[-1] in ".!?…-–—\"'":
            continue
        if word.lower() in _NAME_STOP:
            continue
        keys.add(word.lower()[:3])
    return keys


def similarity_matrix(et: np.ndarray, er: np.ndarray, t_text: list[str], r_text: list[str]) -> np.ndarray:
    s = (et @ er.T).astype(np.float32)
    t_empty = np.array([not t for t in t_text])
    r_empty = np.array([not t for t in r_text])
    s[t_empty, :] = 0.0
    s[:, r_empty] = 0.0

    # Shared numbers and names are strong hints that embeddings may underrate.
    index: dict[tuple[str, str], list[int]] = {}
    for j, text in enumerate(r_text):
        for num in _numbers(text):
            index.setdefault(("n", num), []).append(j)
        for name in _names(text):
            index.setdefault(("w", name), []).append(j)
    bonus = np.zeros_like(s)
    for i, text in enumerate(t_text):
        for num in _numbers(text):
            for j in index.get(("n", num), ()):
                bonus[i, j] += 0.06
        for name in _names(text):
            for j in index.get(("w", name), ()):
                bonus[i, j] += 0.04
    s += np.minimum(bonus, 0.1) * (s > 0.2)
    return s


# ---------------------------------------------------------------------------
# Anchors and chain
# ---------------------------------------------------------------------------


def _candidates(s: np.ndarray, params: AlignParams) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n, m = s.shape
    k_row = min(params.knn, m)
    k_col = min(params.knn, n)
    knn_t = np.partition(s, m - k_row, axis=1)[:, m - k_row :].mean(axis=1)
    knn_r = np.partition(s, n - k_col, axis=0)[n - k_col :, :].mean(axis=0)

    kr = min(params.topk, m)
    kc = min(params.topk, n)
    rows = np.argpartition(s, m - kr, axis=1)[:, m - kr :]
    cols = np.argpartition(s, n - kc, axis=0)[n - kc :, :]
    pairs = set()
    for i in range(n):
        for j in rows[i]:
            pairs.add((i, int(j)))
    for j in range(m):
        for i in cols[:, j]:
            pairs.add((int(i), j))
    if not pairs:
        return np.zeros(0, int), np.zeros(0, int), np.zeros(0)
    arr = np.array(sorted(pairs), dtype=np.int64)
    ii, jj = arr[:, 0], arr[:, 1]
    sims = s[ii, jj]
    keep = sims >= params.min_sim
    ii, jj, sims = ii[keep], jj[keep], sims[keep]
    margin = sims / np.clip((knn_t[ii] + knn_r[jj]) / 2, 1e-3, None)
    weight = np.clip((sims - params.min_sim) / 0.35, 0, 1) * np.clip((margin - 0.98) / 0.2, 0.05, 1.5)
    keep = weight > 0.01
    ii, jj, weight = ii[keep], jj[keep], weight[keep]
    if len(ii) > params.max_anchors:
        top = np.argsort(-weight)[: params.max_anchors]
        top.sort()
        ii, jj, weight = ii[top], jj[top], weight[top]
    return ii, jj, weight


def _best_chain(
    ii: np.ndarray, jj: np.ndarray, w: np.ndarray, t_start: np.ndarray, r_start: np.ndarray, speed: float,
    params: AlignParams,
) -> tuple[list[int], float]:
    a = len(ii)
    if a == 0:
        return [], 0.0
    offsets = r_start[jj] - speed * t_start[ii]
    score = np.zeros(a)
    back = np.full(a, -1, dtype=np.int64)
    for b in range(a):
        if b:
            valid = (ii[:b] < ii[b]) & (jj[:b] < jj[b])
            d_off = np.abs(offsets[:b] - offsets[b])
            trans = np.where(d_off <= params.tol, -0.1 * d_off / params.tol, -params.cut_penalty)
            cand = np.where(valid, score[:b] + trans, -np.inf)
            k = int(np.argmax(cand))
            if cand[k] > 0:
                score[b] = w[b] + cand[k]
                back[b] = k
                continue
        score[b] = w[b]
    end = int(np.argmax(score))
    chain = []
    while end >= 0:
        chain.append(end)
        end = int(back[end])
    chain.reverse()
    return chain, float(score.max())


def _is_strong(group: list[tuple[int, int, float]], params: AlignParams) -> bool:
    """A segment needs a few anchors, or two very confident ones (sparse transcripts)."""
    weight = sum(a[2] for a in group)
    if weight < params.min_segment_weight:
        return False
    return len(group) >= params.min_segment_anchors or (len(group) >= 2 and weight >= 2.2)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    v, wt = values[order], weights[order]
    cum = np.cumsum(wt)
    return float(v[np.searchsorted(cum, cum[-1] / 2)])


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def align(
    target: list[Cue],
    reference: list[Cue],
    t_text: list[str],
    r_text: list[str],
    et: np.ndarray,
    er: np.ndarray,
    duration: float | None = None,
    is_transcript: bool = False,
    params: AlignParams | None = None,
    fill_min_seconds: float = 4.0,
    speech: list[tuple[float, float]] | None = None,
) -> Alignment:
    params = params or AlignParams.for_reference(is_transcript)
    n, m = len(target), len(reference)
    if n == 0 or m == 0:
        raise AlignmentError("Nothing to align")
    t_start = np.array([c.start for c in target])
    t_end = np.array([c.end for c in target])
    r_start = np.array([c.start for c in reference])
    r_end = np.array([c.end for c in reference])
    t_ok = np.array([bool(t) for t in t_text])
    r_ok = np.array([bool(t) for t in r_text])

    s = similarity_matrix(et, er, t_text, r_text)
    ii, jj, w = _candidates(s, params)
    # Generic lines ("Sorry.", "Whoa!") resemble many others; to count as confirmed they need a
    # local match clearly above their usual similarity level.
    k_row = min(params.knn, m)
    line_threshold = np.maximum(
        params.evidence_threshold, np.partition(s, m - k_row, axis=1)[:, m - k_row :].mean(axis=1) - 0.05
    )

    # --- segments ----------------------------------------------------------
    Anchor = tuple[int, int, float]

    def offset_of(a: Anchor, spd: float) -> float:
        return r_start[a[1]] - spd * t_start[a[0]]

    def split(anchor_list: list[Anchor], spd: float) -> list[list[Anchor]]:
        # Compare with the recent median offset of the group, not just the previous anchor, so a
        # wrong speed cannot creep along in small steps.
        groups: list[list[Anchor]] = []
        for a in anchor_list:
            if groups:
                recent = np.median([offset_of(x, spd) for x in groups[-1][-25:]])
                if abs(offset_of(a, spd) - recent) <= params.tol:
                    groups[-1].append(a)
                    continue
            groups.append([a])
        return groups

    def segment_groups(anchor_list: list[Anchor], spd: float) -> list[list[Anchor]]:
        # Drop weak groups (a few stray anchors) and re-split, so neighbours with equal offsets merge.
        groups = split(anchor_list, spd)
        for _ in range(10):
            strong = [g for g in groups if _is_strong(g, params)]
            if len(strong) == len(groups):
                break
            if not strong:
                strong = [max(groups, key=lambda g: sum(x[2] for x in g))]
            groups = split([a for g in strong for a in g], spd)
        return groups

    def fit_score(groups: list[list[Anchor]], spd: float) -> float:
        score = 0.0
        for g in groups:
            offs = np.array([offset_of(a, spd) for a in g])
            med = float(np.median(offs))
            score += float(sum(a[2] * max(0.0, 1.0 - abs(o - med) / params.tol) for a, o in zip(g, offs)))
        return score - params.cut_penalty * (len(groups) - 1)

    # --- best chain and segmentation over candidate speeds -------------------
    results = []
    for spd in params.speeds:
        chain_idx, _ = _best_chain(ii, jj, w, t_start, r_start, spd, params)
        chain_anchors = [(int(ii[c]), int(jj[c]), float(w[c])) for c in chain_idx]
        groups = segment_groups(chain_anchors, spd) if chain_anchors else []
        results.append((fit_score(groups, spd) if groups else 0.0, spd, groups))
    chain_score, speed, groups = max(results, key=lambda r: r[0])
    # Prefer "no speed change" unless another ratio fits clearly better. 24 vs 23.976 fps (0.1 %)
    # needs a bigger margin: on a long film it drifts 7 s and wins easily, on a short one it is noise.
    margin = 0.95 if abs(speed - 1.0) < 0.002 else 0.98
    if speed != 1.0 and results[0][0] >= margin * chain_score:
        chain_score, speed, groups = results[0]
    min_anchors = max(8, int(0.03 * t_ok.sum()))
    n_anchors = sum(len(g) for g in groups)
    if n_anchors < min_anchors:
        raise AlignmentError(
            f"Only {n_anchors} lines could be matched to the reference (need {min_anchors}); "
            "the subtitles are probably for a different video"
        )

    # Refine the speed with a pooled regression inside segments (catches odd frame-rate ratios).
    xs, ys = [], []
    for g in groups:
        if len(g) < 5:
            continue
        tp = np.array([t_start[a[0]] for a in g])
        rr = np.array([r_start[a[1]] for a in g])
        xs.append(tp - tp.mean())
        ys.append(rr - rr.mean())
    if xs:
        x = np.concatenate(xs)
        y = np.concatenate(ys)
        if float((x * x).sum()) > 300.0**2:
            refined = float((x * y).sum() / (x * x).sum())
            resid = np.abs(y - refined * x)
            inl = resid <= max(0.5, 3 * np.median(resid))
            refined = float((x[inl] * y[inl]).sum() / max((x[inl] ** 2).sum(), 1e-9))
            # Small drifts only; a deviation below 0.08 % is noise, keep the standard ratio then.
            if 0.0008 <= abs(refined / speed - 1) < 0.003:
                speed = refined

    # Segment offsets: weighted median of start-time differences. End times help when one line
    # was split differently on each side, but transcript end times run late, so only for subtitles.
    segments: list[Segment] = []
    for g in groups:
        start_obs = np.array([r_start[a[1]] - speed * t_start[a[0]] for a in g])
        wts = np.array([a[2] for a in g])
        if is_transcript:
            off = _weighted_median(start_obs, wts)
        else:
            end_obs = np.array([r_end[a[1]] - speed * t_end[a[0]] for a in g])
            off = _weighted_median(np.concatenate([start_obs, end_obs]), np.concatenate([wts, 0.5 * wts]))
        mad = float(np.median(np.abs(start_obs - off)))
        segments.append(Segment(anchors=[(a[0], a[1]) for a in g], weight=sum(a[2] for a in g), offset=off, mad=mad))

    # --- evidence helper -----------------------------------------------------
    order_r = np.argsort(r_start)
    rs_sorted = r_start[order_r]
    max_ref_dur = float(np.max(r_end - r_start)) if m else 0.0
    no_ref_penalty = -0.1 if is_transcript else -0.25

    # Speech activity (when available): a line placed over silence or music is suspicious,
    # a line over speech that the transcript missed is fine.
    speech_cum = None
    if speech:
        res = 0.1
        horizon = max(float(r_end.max()), float(t_end.max()) * 1.2, duration or 0.0) + 60
        mask = np.zeros(int(horizon / res) + 2)
        for a, b in speech:
            mask[max(0, int(a / res)) : max(0, int(b / res)) + 1] = 1.0
        speech_cum = np.concatenate([[0.0], np.cumsum(mask)])

    def speech_term(t0: float, t1: float) -> float:
        if speech_cum is None:
            return 0.0
        lo = int(np.clip(t0 / 0.1, 0, len(speech_cum) - 1))
        hi = int(np.clip(t1 / 0.1, lo + 1, len(speech_cum) - 1))
        frac = (speech_cum[hi] - speech_cum[lo]) / max(hi - lo, 1)
        return 0.25 * (2.0 * frac - 1.0)

    def evidence(i: int, t0: float, t1: float) -> float:
        return text_evidence(i, t0, t1) + speech_term(t0, t1)

    def text_evidence(i: int, t0: float, t1: float) -> float:
        if not t_ok[i]:
            return 0.0
        lo = np.searchsorted(rs_sorted, t0 - params.local_window - max_ref_dur)
        hi = np.searchsorted(rs_sorted, t1 + params.local_window, side="right")
        js = order_r[lo:hi]
        js = js[r_end[js] >= t0 - params.local_window]
        if len(js) == 0:
            return no_ref_penalty
        sim = float(s[i, js].max())
        return float(np.clip(sim - line_threshold[i], -0.4, 0.5))

    def mapped(i: int, seg: Segment) -> tuple[float, float]:
        return speed * t_start[i] + seg.offset, speed * t_end[i] + seg.offset

    # --- assignment ------------------------------------------------------------
    assignment: list[int | None] = [None] * n
    cuts: list[Cut] = []
    for k, seg in enumerate(segments):
        for i in range(seg.first, seg.last + 1):
            assignment[i] = k
    for i in range(0, segments[0].first):
        assignment[i] = 0
    for i in range(segments[-1].last + 1, n):
        assignment[i] = len(segments) - 1

    for k in range(len(segments) - 1):
        prev, nxt = segments[k], segments[k + 1]
        gap = list(range(prev.last + 1, nxt.first))
        limit_prev = r_start[nxt.anchors[0][1]]  # lines of the earlier segment must end before this
        limit_next = r_end[prev.anchors[-1][1]]  # lines of the later segment must start after this
        g = len(gap)
        ev_prev = np.zeros(g)
        ev_next = np.zeros(g)
        for idx, i in enumerate(gap):
            a0, a1 = mapped(i, prev)
            b0, b1 = mapped(i, nxt)
            ev_prev[idx] = evidence(i, a0, a1) - (1.0 if a1 > limit_prev + 0.3 else 0.0)
            ev_next[idx] = evidence(i, b0, b1) - (1.0 if b0 < limit_next - 0.3 else 0.0)
        drop = np.full(g, -params.drop_penalty)
        pk = np.concatenate([[0.0], np.cumsum(ev_prev)])
        pd = np.concatenate([[0.0], np.cumsum(drop)])
        sk = np.concatenate([np.cumsum(ev_next[::-1])[::-1], [0.0]])
        # x gap lines go to the earlier segment, [x, y) are dropped, the rest go to the later one.
        # The last kept line before the cut must end before the first kept line after it starts.
        last_end = np.array([mapped(prev.last, prev)[1]] + [mapped(i, prev)[1] for i in gap])
        first_start = np.array([mapped(i, nxt)[0] for i in gap] + [mapped(nxt.first, nxt)[0]])
        xs = np.arange(g + 1)[:, None]
        ys = np.arange(g + 1)[None, :]
        overlap = np.maximum(0.0, last_end[:, None] - first_start[None, :] - 0.3)
        # Priors: the dropped stretch should not be longer than the offset jump explains (nothing
        # needs dropping when the video is the longer version), and cuts sit at pauses (scene changes).
        bounds = [prev.last] + gap + [nxt.first]
        pause = np.array([t_start[bounds[p + 1]] - t_end[bounds[p]] for p in range(g + 1)])
        boundary = 0.02 * np.minimum(np.maximum(pause, 0.0), 6.0)
        gs = np.array(gap + [nxt.first])
        span = speed * (np.concatenate([[t_end[prev.last]], t_end[gs[:-1]]])[None, :] - t_start[gs][:, None])
        allowed = max(0.0, prev.offset - nxt.offset)
        excess = np.where(ys > xs, np.maximum(0.0, span - allowed - 2.0), 0.0)
        table = (
            (pk - pd)[:, None] + (pd + sk)[None, :] - 2.0 * overlap - 0.25 * excess
            + boundary[:, None] + boundary[None, :]
        )
        table = np.where(xs <= ys, table, -np.inf)
        x, y = (int(v) for v in np.unravel_index(int(np.argmax(table)), table.shape))
        for idx, i in enumerate(gap):
            assignment[i] = k if idx < x else (None if idx < y else k + 1)
        first_after = gap[y] if y < g else nxt.first
        cuts.append(
            Cut(
                subtitle_time=float(t_start[first_after]),
                video_time=float(mapped(first_after, nxt)[0]),
                jump=float(nxt.offset - prev.offset),
                dropped=y - x,
            )
        )

    # Lines pushed outside the video at either end.
    for i in range(n):
        k = assignment[i]
        if k is None:
            continue
        a0, a1 = mapped(i, segments[k])
        if a1 <= 0 or (duration and a0 >= duration + 1.0):
            assignment[i] = None

    # --- output cues ---------------------------------------------------------
    rows = []
    for i in range(n):
        k = assignment[i]
        if k is None:
            continue
        a0, a1 = mapped(i, segments[k])
        rows.append([max(0.0, a0), max(0.0, a1), i, k])
    rows.sort(key=lambda r: (r[0], r[1]))
    for p, q in zip(rows, rows[1:]):
        if p[3] != q[3] and p[1] > q[0]:
            p[1] = max(p[0] + 0.3, q[0] - 0.05)
    out_cues = [Cue(r[0], r[1], target[r[2]].text) for r in rows]
    source_index = [r[2] for r in rows]

    chain_targets = {a[0] for seg in segments for a in seg.anchors}
    chain_refs = {a[1] for seg in segments for a in seg.anchors}
    verified = [False] * n
    for r in rows:
        i = r[2]
        verified[i] = i in chain_targets or text_evidence(i, r[0], r[1]) >= 0.05

    # --- regions of the video without subtitle lines ---------------------------
    regions: list[Region] = []

    def ref_lines_between(lo: float, hi: float) -> list[int]:
        return [
            j for j in range(m)
            if r_ok[j] and j not in chain_refs and r_start[j] >= lo - 0.2 and r_end[j] <= hi + 0.2
        ]

    by_segment: dict[int, list[list]] = {}
    for r in rows:
        by_segment.setdefault(r[3], []).append(r)
    for k, cut in enumerate(cuts):
        if cut.jump < fill_min_seconds:
            continue
        before = by_segment.get(k, [])
        after = by_segment.get(k + 1, [])
        if not before or not after:
            continue
        lo = max(r[1] for r in before)
        hi = min(r[0] for r in after)
        if hi - lo < fill_min_seconds:
            continue
        js = ref_lines_between(lo, hi)
        if js:
            regions.append(Region(lo, hi, js, "cut"))
    if rows:
        first_out = rows[0][0]
        js = ref_lines_between(0.0, first_out - 0.1)
        if len(js) >= 3 and first_out >= 20:
            regions.append(Region(0.0, first_out, js, "edge"))
        last_out = max(r[1] for r in rows)
        end = duration or float(r_end.max())
        js = ref_lines_between(last_out + 0.1, end)
        if len(js) >= 3 and end - last_out >= 20:
            regions.append(Region(last_out, end, js, "edge"))
    regions.sort(key=lambda r: r.start)

    # --- confidence --------------------------------------------------------------
    kept_text = [i for i in range(n) if assignment[i] is not None and t_ok[i]]
    verified_ratio = sum(verified[i] for i in kept_text) / max(1, len(kept_text))
    expected = 0.55 if is_transcript else 0.75
    c_match = min(1.0, verified_ratio / expected)
    total_w = sum(seg.weight for seg in segments)
    mad = sum(seg.mad * seg.weight for seg in segments) / max(total_w, 1e-9)
    c_timing = 1.0 if mad <= 0.35 else max(0.3, 1.0 - (mad - 0.35) / 1.5)
    hours = max((duration or float(r_end.max())) / 3600.0, 0.25)
    cuts_per_hour = len(cuts) / hours
    c_cuts = 1.0 if cuts_per_hour <= 12 else 12.0 / cuts_per_hour
    dropped = sum(1 for k in assignment if k is None)
    dropped_frac = dropped / n
    c_drop = 1.0 if dropped_frac <= 0.25 else max(0.2, 1.0 - (dropped_frac - 0.25) * 2)
    confidence = float(c_match * c_timing * c_cuts * c_drop)

    stats = {
        "target_lines": n,
        "reference_lines": m,
        "anchors": sum(len(seg.anchors) for seg in segments),
        "kept": n - dropped,
        "dropped": dropped,
        "verified_ratio": round(verified_ratio, 3),
        "timing_mad_seconds": round(mad, 3),
        "speed": round(speed, 6),
        "chain_score": round(chain_score, 2),
        "confidence_parts": {
            "matching": round(c_match, 3),
            "timing": round(c_timing, 3),
            "cuts": round(c_cuts, 3),
            "dropped": round(c_drop, 3),
        },
    }
    return Alignment(
        speed=speed,
        segments=segments,
        assignment=assignment,
        cues=out_cues,
        source_index=source_index,
        verified=verified,
        cuts=cuts,
        regions=regions,
        confidence=confidence,
        stats=stats,
    )
