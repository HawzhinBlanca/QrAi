/// FL6 — the learner-facing feedback surface.
///
/// ── The rule, made structural ───────────────────────────────────────────────────────────────────
/// A tajweed finding must never reach a learner without a source, a confidence, and a human
/// approval. Two layers enforce that and they are deliberately redundant:
///
/// 1. `TajweedFinding` REQUIRES status, confidence and source, so a payload missing any of them
///    fails to PARSE and never becomes an object at all.
/// 2. This widget filters on `isLearnerVisible` — which is `status == 'scholar-approved'` and
///    nothing else — and renders the source and confidence ALONGSIDE every finding it shows.
///
/// The second layer is not belt-and-braces for its own sake: a learner who is shown a judgement
/// about their recitation of the Qur'an is entitled to see who stands behind it. Showing the
/// finding without its provenance is a different product than showing both.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';

class TajweedPanel extends StatelessWidget {
  const TajweedPanel({super.key, required this.findings});

  final List<TajweedFinding> findings;

  @override
  Widget build(BuildContext context) {
    // The ONLY predicate. Not "confidence is high enough" — a model's confidence is not a scholar's
    // approval, and letting a threshold stand in for one is the substitution this gate refuses.
    final List<TajweedFinding> visible =
        findings.where((TajweedFinding f) => f.isLearnerVisible).toList(growable: false);

    if (visible.isEmpty) {
      // Deliberately not "no mistakes found". Everything here may be awaiting review, and telling a
      // learner their recitation was clean when nobody has looked at it yet is a fabrication.
      return const Padding(
        key: ValueKey<String>('tajweed-none'),
        padding: EdgeInsets.all(16),
        child: Text('No reviewed feedback yet.'),
      );
    }

    return ListView.builder(
      key: const ValueKey<String>('tajweed-list'),
      shrinkWrap: true,
      itemCount: visible.length,
      itemBuilder: (BuildContext context, int i) => _FindingTile(finding: visible[i]),
    );
  }
}

class _FindingTile extends StatelessWidget {
  const _FindingTile({required this.finding});

  final TajweedFinding finding;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ListTile(
      key: ValueKey<String>('finding-${finding.id}'),
      title: Text(finding.rule),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (finding.detail != null) Text(finding.detail!),
          // Provenance, always, next to the finding it belongs to. A learner shown a judgement
          // about their recitation is entitled to see who stands behind it.
          Text(
            'Source: ${finding.source}',
            key: ValueKey<String>('finding-source-${finding.id}'),
            style: theme.textTheme.labelSmall,
          ),
          Text(
            'Confidence: ${(finding.confidence * 100).round()}%',
            key: ValueKey<String>('finding-confidence-${finding.id}'),
            style: theme.textTheme.labelSmall,
          ),
        ],
      ),
    );
  }
}
