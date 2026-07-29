"""Tests for eval_metrics — runnable with a plain interpreter (numpy only, no model, no torch).

    python test_eval_metrics.py

These are known-answer tests wherever a value can be worked out by hand, because statistics code
fails silently: a wrong AUPRC still returns a plausible number between 0 and 1. Each hand-computed
expectation is derived in the test's own comment so it can be checked without trusting the
implementation it is testing.
"""
import math

import numpy as np

from eval_metrics import (
    average_precision,
    cluster_bootstrap_ci,
    design_effect,
    expected_calibration_error,
    icc_oneway,
    krippendorff_alpha_nominal,
    precision_recall_f1,
    reliability_bins,
    required_clusters,
    roc_auc,
)

# --------------------------------------------------------------------------------------
# average_precision (AUPRC)
# --------------------------------------------------------------------------------------

def test_average_precision_known_answer():
    """y=[1,0,1,0] with descending scores.

    Operating points, highest score first:
        tp=1 fp=0 -> P=1,   R=0.5
        tp=1 fp=1 -> P=0.5, R=0.5
        tp=2 fp=1 -> P=2/3, R=1
        tp=2 fp=2 -> P=0.5, R=1
    AP = Σ ΔR·P = 0.5·1 + 0·0.5 + 0.5·(2/3) + 0·0.5 = 1/2 + 1/3 = 5/6.

    This value also pins the STEP-wise definition: trapezoidal auc(recall, precision) would
    average adjacent precisions and return something else.
    """
    ap = average_precision([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.6])
    assert abs(ap - 5 / 6) < 1e-12, ap


def test_average_precision_perfect_and_inverted():
    assert abs(average_precision([1, 1, 0, 0], [0.9, 0.8, 0.2, 0.1]) - 1.0) < 1e-12
    # Perfectly inverted ranking: every positive sits below every negative.
    ap = average_precision([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1])
    assert ap < 0.6, ap


def test_average_precision_no_positives_is_nan_not_zero():
    # Undefined, and must not be silently averaged into a cohort summary as 0.0.
    assert math.isnan(average_precision([0, 0, 0], [0.3, 0.2, 0.1]))


def test_average_precision_collapses_ties():
    # All scores identical -> one operating point, precision = prevalence.
    ap = average_precision([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5])
    assert abs(ap - 0.5) < 1e-12, ap


# --------------------------------------------------------------------------------------
# roc_auc
# --------------------------------------------------------------------------------------

def test_roc_auc_known_answer():
    """Same data as above. Concordant pairs, counting positives against negatives:
    (0.9>0.8)Y (0.9>0.6)Y (0.7<0.8)N (0.7>0.6)Y  ->  3/4 = 0.75.
    """
    assert abs(roc_auc([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.6]) - 0.75) < 1e-12


def test_roc_auc_all_ties_is_exactly_half():
    # The tie-handling test: average ranks must give 0.5, not an artifact of sort order.
    assert abs(roc_auc([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5]) - 0.5) < 1e-12


def test_roc_auc_single_class_is_nan():
    assert math.isnan(roc_auc([1, 1, 1], [0.9, 0.5, 0.1]))


# --------------------------------------------------------------------------------------
# precision_recall_f1
# --------------------------------------------------------------------------------------

def test_precision_recall_f1_known_answer():
    # threshold 0.5: predicted positive = scores[0.9, 0.6] -> tp=1 (y=1), fp=1 (y=0), fn=1
    r = precision_recall_f1([1, 0, 0, 1], [0.9, 0.6, 0.4, 0.1], threshold=0.5)
    assert r["tp"] == 1 and r["fp"] == 1 and r["fn"] == 1, r
    assert abs(r["precision"] - 0.5) < 1e-12
    assert abs(r["recall"] - 0.5) < 1e-12
    assert abs(r["f1"] - 0.5) < 1e-12


def test_precision_undefined_when_nothing_predicted_positive():
    r = precision_recall_f1([1, 0], [0.1, 0.2], threshold=0.9)
    assert math.isnan(r["precision"]), r


# --------------------------------------------------------------------------------------
# calibration
# --------------------------------------------------------------------------------------

def test_ece_known_answer_overconfident():
    # All four predictions claim 0.9; only half are correct. Single bin: |0.5 - 0.9| = 0.4.
    ece = expected_calibration_error([1, 1, 0, 0], [0.9, 0.9, 0.9, 0.9], n_bins=10)
    assert abs(ece - 0.4) < 1e-12, ece


def test_ece_near_zero_when_calibrated():
    # 1000 draws where the label really does occur with probability p.
    rng = np.random.default_rng(0)
    p = rng.uniform(0.05, 0.95, 4000)
    y = (rng.uniform(size=p.size) < p).astype(int)
    assert expected_calibration_error(y, p, n_bins=10) < 0.05


def test_reliability_bins_report_empty_bins_rather_than_dropping_them():
    bins = reliability_bins([1, 0], [0.95, 0.92], n_bins=10)
    assert len(bins) == 10
    assert bins[9]["count"] == 2
    assert bins[0]["count"] == 0 and math.isnan(bins[0]["accuracy"])


# --------------------------------------------------------------------------------------
# cluster bootstrap — the reason this module exists
# --------------------------------------------------------------------------------------

def _clustered_data(seed=7, n_clusters=20, per=25, within_sd=0.05):
    """Strong cluster structure: nearly all variance is BETWEEN clusters (ICC near 1)."""
    rng = np.random.default_rng(seed)
    cluster_means = rng.normal(0.0, 1.0, n_clusters)
    values = np.concatenate([cluster_means[i] + rng.normal(0.0, within_sd, per)
                             for i in range(n_clusters)])
    ids = np.repeat(np.arange(n_clusters), per)
    return values, ids


def test_cluster_bootstrap_is_wider_than_row_bootstrap_under_clustering():
    """The whole point of the function.

    With 20 reciters x 25 correlated words, a row-wise bootstrap acts as if there were 500
    independent observations and reports a far too narrow interval. Resampling reciters must
    produce a visibly wider CI. Expected SE ratio here is ~sqrt(DEFF) with DEFF ~= 1+24*ICC,
    i.e. roughly 5x; asserting >3x leaves headroom for sampling noise.
    """
    values, ids = _clustered_data()
    stat = lambda idx: float(values[idx].mean())  # noqa: E731

    clustered = cluster_bootstrap_ci(stat, ids, n_resamples=2000, seed=1)
    clustered_width = clustered["hi"] - clustered["lo"]

    rng = np.random.default_rng(2)
    naive = np.array([values[rng.integers(0, values.size, values.size)].mean()
                      for _ in range(2000)])
    naive_width = float(np.percentile(naive, 97.5) - np.percentile(naive, 2.5))

    assert clustered_width > 3 * naive_width, (clustered_width, naive_width)
    assert clustered["n_clusters"] == 20


def test_cluster_bootstrap_ci_brackets_the_point_estimate():
    values, ids = _clustered_data()
    stat = lambda idx: float(values[idx].mean())  # noqa: E731
    out = cluster_bootstrap_ci(stat, ids, n_resamples=1000, seed=3)
    assert out["lo"] <= out["point"] <= out["hi"], out


def test_cluster_bootstrap_is_deterministic_for_a_seed():
    values, ids = _clustered_data()
    stat = lambda idx: float(values[idx].mean())  # noqa: E731
    a = cluster_bootstrap_ci(stat, ids, n_resamples=500, seed=42)
    b = cluster_bootstrap_ci(stat, ids, n_resamples=500, seed=42)
    assert a == b


def test_cluster_bootstrap_survives_nan_resamples():
    # A statistic that is undefined for some draws must not poison the percentiles.
    values, ids = _clustered_data(n_clusters=6, per=4)
    def flaky(idx):
        return float("nan") if idx.size % 2 == 0 else float(values[idx].mean())
    out = cluster_bootstrap_ci(flaky, ids, n_resamples=200, seed=5)
    assert out["n_valid"] <= out["n_resamples"]


# --------------------------------------------------------------------------------------
# Krippendorff's alpha
# --------------------------------------------------------------------------------------

def test_krippendorff_perfect_agreement_is_one():
    assert abs(krippendorff_alpha_nominal([[0, 0], [0, 0], [1, 1], [1, 1]]) - 1.0) < 1e-12


def test_krippendorff_systematic_disagreement_known_answer():
    """Four units, two coders, they disagree on every unit.

    Coincidence matrix o = [[0,4],[4,0]] (each unit contributes 1 to o_01 and 1 to o_10,
    divided by m_u-1 = 1). Marginals n_c = [4,4], n = 8.
        D_o = Σ_{c≠k} o_ck        = 8
        D_e = Σ_{c≠k} n_c·n_k     = 16 + 16 = 32
        α   = 1 − (n−1)·D_o/D_e   = 1 − 7·8/32 = −0.75
    Negative alpha = worse than chance, which is the correct reading of systematic disagreement.
    """
    alpha = krippendorff_alpha_nominal([[0, 1], [1, 0], [0, 1], [1, 0]])
    assert abs(alpha - (-0.75)) < 1e-12, alpha


def test_krippendorff_random_labels_near_zero():
    rng = np.random.default_rng(11)
    units = [[int(v) for v in rng.integers(0, 2, 2)] for _ in range(4000)]
    alpha = krippendorff_alpha_nominal(units)
    assert abs(alpha) < 0.06, alpha


def test_krippendorff_ignores_single_rating_units():
    # A unit rated once carries no agreement information; it must not change the result.
    both = krippendorff_alpha_nominal([[0, 0], [1, 1], [0]])
    only_pairs = krippendorff_alpha_nominal([[0, 0], [1, 1]])
    assert abs(both - only_pairs) < 1e-12


def test_krippendorff_handles_more_than_two_annotators_and_strings():
    alpha = krippendorff_alpha_nominal([["ok", "ok", "ok"], ["bad", "bad", "bad"]])
    assert abs(alpha - 1.0) < 1e-12


def test_krippendorff_single_category_is_one():
    # No disagreement was possible; report 1.0 rather than dividing by zero.
    assert krippendorff_alpha_nominal([["a", "a"], ["a", "a"]]) == 1.0


# --------------------------------------------------------------------------------------
# ICC and design effect
# --------------------------------------------------------------------------------------

def test_icc_high_when_variance_is_between_clusters():
    values, ids = _clustered_data(within_sd=0.05)
    assert icc_oneway(values, ids) > 0.9


def test_icc_near_zero_when_rows_are_independent():
    rng = np.random.default_rng(13)
    values = rng.normal(size=500)
    ids = np.repeat(np.arange(20), 25)  # cluster labels carry no signal
    assert abs(icc_oneway(values, ids)) < 0.15


def test_design_effect_and_required_clusters_match_the_spec_arithmetic():
    # spec §5.3: ICC 0.10, 20 error-bearing words per reciter -> DEFF = 1 + 19(0.10) = 2.9
    assert abs(design_effect(0.10, 20) - 2.9) < 1e-12
    # 160 independent observations per arm -> 160*2.9/20 = 23.2 -> 24 reciters
    assert required_clusters(160, 0.10, 20) == 24


def test_design_effect_is_one_without_clustering():
    assert design_effect(0.0, 20) == 1.0


# --------------------------------------------------------------------------------------
# input validation
# --------------------------------------------------------------------------------------

def test_rejects_mismatched_lengths_and_non_binary_labels():
    for bad in (lambda: average_precision([1, 0], [0.5]),
                lambda: average_precision([1, 2], [0.5, 0.4]),
                lambda: reliability_bins([1, 0], [1.5, 0.4])):
        try:
            bad()
        except ValueError:
            continue
        raise AssertionError("expected ValueError")


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as exc:  # noqa: BLE001 — a test runner reports, it does not re-raise
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
