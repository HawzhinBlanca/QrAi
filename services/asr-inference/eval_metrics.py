"""Evaluation statistics for recitation models — the shared core for
specs/kurdish-asr-evaluation/spec.md.

Pure functions over numpy arrays. No I/O, no model imports, no torch — so this runs (and is
tested) without downloading a model.

    python test_eval_metrics.py

numpy only, deliberately: sklearn/scipy would be new runtime dependencies, which AGENTS.md
requires an ADR for, and every function here is a few lines of numpy. If a future need is
genuinely heavier than this, that is the moment to write the ADR — not now.

Three correctness decisions worth stating, because each has a plausible-looking wrong version:

  * `average_precision` sums precision over recall STEPS. The common alternative,
    trapezoidal `auc(recall, precision)`, interpolates between operating points that no
    threshold actually produces, and over-reports when positives are sparse — which is exactly
    the regime here (mispronunciations are the minority class).

  * `roc_auc` uses the rank / Mann-Whitney form with AVERAGE ranks, so tied scores are handled
    exactly. Alignment scores tie often (silence, very short words), and a naive sort-based
    AUC silently picks an arbitrary within-tie order.

  * `cluster_bootstrap_ci` resamples CLUSTERS (reciters), not rows. Words within one reciter
    are correlated, so a row-wise bootstrap reports confidence intervals that are too narrow —
    it treats 500 correlated words as 500 independent observations. See spec §9.
"""

from collections import Counter
from typing import Callable, Iterable, Sequence

import numpy as np

__all__ = [
    "average_precision",
    "roc_auc",
    "precision_recall_f1",
    "reliability_bins",
    "expected_calibration_error",
    "cluster_bootstrap_ci",
    "krippendorff_alpha_nominal",
    "icc_oneway",
    "design_effect",
    "required_clusters",
]


def _as_arrays(y_true: Sequence, y_score: Sequence) -> tuple[np.ndarray, np.ndarray]:
    y = np.asarray(y_true).astype(np.int64).ravel()
    s = np.asarray(y_score, dtype=np.float64).ravel()
    if y.shape != s.shape:
        raise ValueError(f"y_true and y_score must be the same length ({y.shape} vs {s.shape})")
    if y.size == 0:
        raise ValueError("empty input")
    bad = set(np.unique(y).tolist()) - {0, 1}
    if bad:
        raise ValueError(f"y_true must be binary 0/1, got extra values: {sorted(bad)}")
    return y, s


def _rankdata_average(a: np.ndarray) -> np.ndarray:
    """Ranks of `a`, ties given their average rank (scipy.stats.rankdata's default)."""
    sorter = np.argsort(a, kind="mergesort")
    inv = np.empty(sorter.size, dtype=np.intp)
    inv[sorter] = np.arange(sorter.size)
    a_sorted = a[sorter]
    obs = np.r_[True, a_sorted[1:] != a_sorted[:-1]]
    dense = obs.cumsum()[inv]
    # `count` holds the start index of each run of equal values, plus the end sentinel.
    count = np.r_[np.nonzero(obs)[0], a.size]
    return 0.5 * (count[dense] + count[dense - 1] + 1)


def _binary_clf_curve(y: np.ndarray, s: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cumulative (fps, tps) at each DISTINCT score threshold, highest score first.

    Collapsing tied scores matters: evaluating mid-tie would credit an ordering the model never
    actually expressed.
    """
    order = np.argsort(s, kind="mergesort")[::-1]
    y_ord, s_ord = y[order], s[order]
    distinct = np.where(np.diff(s_ord))[0]
    idx = np.r_[distinct, y_ord.size - 1]
    tps = np.cumsum(y_ord)[idx]
    fps = 1 + idx - tps  # idx+1 samples seen so far, minus the true positives among them
    return fps, tps


def average_precision(y_true: Sequence, y_score: Sequence) -> float:
    """AUPRC as the step-wise sum  Σ (R_n − R_{n−1}) · P_n.

    Returns nan when there are no positives — undefined, not zero. The caller must not silently
    average a nan into a cohort summary.
    """
    y, s = _as_arrays(y_true, y_score)
    fps, tps = _binary_clf_curve(y, s)
    n_pos = tps[-1]
    if n_pos == 0:
        return float("nan")
    precision = tps / (tps + fps)
    recall = tps / n_pos
    return float(np.sum(np.diff(np.r_[0.0, recall]) * precision))


def roc_auc(y_true: Sequence, y_score: Sequence) -> float:
    """ROC AUC via the Mann-Whitney U statistic, exact under ties.

    Returns nan if either class is absent (undefined).
    """
    y, s = _as_arrays(y_true, y_score)
    n_pos = int(y.sum())
    n_neg = y.size - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = _rankdata_average(s)
    return float((ranks[y == 1].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def precision_recall_f1(y_true: Sequence, y_score: Sequence, threshold: float) -> dict:
    """Operating-point metrics. `score >= threshold` counts as a positive prediction.

    Reported alongside the threshold-free AUPRC because a shipped system has to pick one
    threshold, and the spec's tajweed gate (precision < 0.70 → do not show a learner) is stated
    at an operating point.
    """
    y, s = _as_arrays(y_true, y_score)
    pred = (s >= threshold).astype(np.int64)
    tp = int(np.sum((pred == 1) & (y == 1)))
    fp = int(np.sum((pred == 1) & (y == 0)))
    fn = int(np.sum((pred == 0) & (y == 1)))
    precision = tp / (tp + fp) if (tp + fp) else float("nan")
    recall = tp / (tp + fn) if (tp + fn) else float("nan")
    if np.isnan(precision) or np.isnan(recall) or (precision + recall) == 0:
        f1 = float("nan")
    else:
        f1 = 2 * precision * recall / (precision + recall)
    return {
        "threshold": float(threshold),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": precision, "recall": recall, "f1": f1,
    }


def reliability_bins(y_true: Sequence, y_prob: Sequence, n_bins: int = 10) -> list[dict]:
    """Equal-width reliability bins — the reliability diagram's underlying table.

    `gap` = observed frequency − mean claimed confidence. A well-calibrated score has gaps near
    zero across bins. The tajweed confidences in server.py are single-feature rescalings, so
    large gaps here are the expected finding, not a surprise (spec §4.2).
    """
    y, p = _as_arrays(y_true, y_prob)
    if n_bins < 1:
        raise ValueError("n_bins must be >= 1")
    if p.min() < 0.0 or p.max() > 1.0:
        raise ValueError("y_prob must lie in [0, 1] to be interpreted as a probability")
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1], right=False), 0, n_bins - 1)
    out = []
    for b in range(n_bins):
        mask = idx == b
        count = int(mask.sum())
        if count == 0:
            out.append({"bin": b, "low": float(edges[b]), "high": float(edges[b + 1]),
                        "count": 0, "confidence": float("nan"),
                        "accuracy": float("nan"), "gap": float("nan")})
            continue
        conf = float(p[mask].mean())
        acc = float(y[mask].mean())
        out.append({"bin": b, "low": float(edges[b]), "high": float(edges[b + 1]),
                    "count": count, "confidence": conf, "accuracy": acc,
                    "gap": acc - conf})
    return out


def expected_calibration_error(y_true: Sequence, y_prob: Sequence, n_bins: int = 10) -> float:
    """ECE — count-weighted mean |accuracy − confidence| over non-empty bins."""
    bins = reliability_bins(y_true, y_prob, n_bins)
    total = sum(b["count"] for b in bins)
    if total == 0:
        return float("nan")
    return float(sum(b["count"] * abs(b["gap"]) for b in bins if b["count"]) / total)


def cluster_bootstrap_ci(
    statistic: Callable[[np.ndarray], float],
    cluster_ids: Sequence,
    n_resamples: int = 10_000,
    alpha: float = 0.05,
    seed: int = 0,
) -> dict:
    """Percentile bootstrap CI, resampling CLUSTERS with replacement.

    `statistic` receives an index array into the original rows and returns a scalar. Resampling
    reciters rather than rows is what keeps the interval honest — see the module docstring.

    Resamples yielding nan (e.g. a draw with no positive cases) are dropped and counted, rather
    than poisoning the percentiles; `n_valid` is reported so a degenerate run is visible instead
    of silent.
    """
    ids = np.asarray(cluster_ids).ravel()
    if ids.size == 0:
        raise ValueError("empty cluster_ids")
    if n_resamples < 1:
        raise ValueError("n_resamples must be >= 1")
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be in (0, 1)")

    uniq = np.unique(ids)
    members = {c: np.where(ids == c)[0] for c in uniq}  # precomputed: the loop is the hot path
    rng = np.random.default_rng(seed)

    stats = np.empty(n_resamples, dtype=np.float64)
    for i in range(n_resamples):
        drawn = rng.choice(uniq, size=uniq.size, replace=True)
        idx = np.concatenate([members[c] for c in drawn])
        stats[i] = statistic(idx)

    valid = stats[~np.isnan(stats)]
    if valid.size == 0:
        return {"point": float("nan"), "lo": float("nan"), "hi": float("nan"),
                "n_valid": 0, "n_resamples": n_resamples, "n_clusters": int(uniq.size)}
    return {
        "point": float(statistic(np.arange(ids.size))),
        "lo": float(np.percentile(valid, 100 * alpha / 2)),
        "hi": float(np.percentile(valid, 100 * (1 - alpha / 2))),
        "n_valid": int(valid.size),
        "n_resamples": n_resamples,
        "n_clusters": int(uniq.size),
    }


def krippendorff_alpha_nominal(units: Iterable[Sequence]) -> float:
    """Krippendorff's α for NOMINAL labels, with missing ratings simply absent.

    `units` is one sequence of labels per rated item, e.g. [["a","a"], ["a","b"], ["b"]].
    Units with fewer than 2 ratings carry no agreement information and are skipped.

    α = 1 − D_o/D_e. 1.0 is perfect agreement, 0.0 is chance, negative means systematic
    disagreement (annotators disagree more than random labelling would).

    The spec halts the study below 0.67: model metrics measured against labels that noisy would
    be reporting annotator noise as model error.
    """
    usable = [list(u) for u in units if len(list(u)) >= 2]
    if not usable:
        return float("nan")

    labels = sorted({v for u in usable for v in u}, key=repr)
    index = {lab: i for i, lab in enumerate(labels)}
    o = np.zeros((len(labels), len(labels)), dtype=np.float64)

    for u in usable:
        m_u = len(u)
        counts = Counter(u)
        for c, n_c in counts.items():
            for k, n_k in counts.items():
                pairs = n_c * (n_c - 1) if c == k else n_c * n_k
                o[index[c], index[k]] += pairs / (m_u - 1)

    n_marginal = o.sum(axis=1)
    n_total = n_marginal.sum()
    if n_total < 2:
        return float("nan")

    d_observed = o.sum() - np.trace(o)                                    # Σ_{c≠k} o_ck
    d_expected = np.outer(n_marginal, n_marginal).sum() - np.sum(n_marginal**2)  # Σ_{c≠k} n_c n_k
    if d_expected == 0:
        # Every rating is the same category: no disagreement was possible, so no evidence of
        # unreliability. Conventionally α = 1.
        return 1.0
    return float(1.0 - (n_total - 1.0) * d_observed / d_expected)


def icc_oneway(values: Sequence, cluster_ids: Sequence) -> float:
    """One-way ICC(1) — the share of variance sitting BETWEEN clusters.

    Feeds the design effect, which is how spec §5.3 step 5 revises the target sample size once
    the first reciters are recorded, instead of trusting the assumed ICC of 0.10.
    """
    x = np.asarray(values, dtype=np.float64).ravel()
    ids = np.asarray(cluster_ids).ravel()
    if x.shape != ids.shape:
        raise ValueError("values and cluster_ids must be the same length")
    uniq = np.unique(ids)
    m = uniq.size
    n = x.size
    if m < 2 or n <= m:
        return float("nan")  # needs >= 2 clusters and some within-cluster replication

    grand = x.mean()
    sizes = np.array([np.sum(ids == c) for c in uniq], dtype=np.float64)
    means = np.array([x[ids == c].mean() for c in uniq], dtype=np.float64)

    ms_between = float(np.sum(sizes * (means - grand) ** 2) / (m - 1))
    ss_within = float(sum(np.sum((x[ids == c] - x[ids == c].mean()) ** 2) for c in uniq))
    ms_within = ss_within / (n - m)

    n0 = (n - np.sum(sizes**2) / n) / (m - 1)  # unbalanced-design effective cluster size
    denom = ms_between + (n0 - 1) * ms_within
    if denom == 0:
        return float("nan")
    return float((ms_between - ms_within) / denom)


def design_effect(icc: float, avg_cluster_size: float) -> float:
    """DEFF = 1 + (m − 1)·ICC — how much correlation inflates the required sample size."""
    if avg_cluster_size < 1:
        raise ValueError("avg_cluster_size must be >= 1")
    return float(1.0 + (avg_cluster_size - 1.0) * icc)


def required_clusters(n_per_arm: float, icc: float, avg_cluster_size: float) -> int:
    """Clusters per arm needed once clustering is accounted for (spec §5.3).

    `n_per_arm` is the independent-observation requirement from an ordinary power calculation.
    """
    if avg_cluster_size < 1:
        raise ValueError("avg_cluster_size must be >= 1")
    inflated = n_per_arm * design_effect(icc, avg_cluster_size)
    return int(np.ceil(inflated / avg_cluster_size))
