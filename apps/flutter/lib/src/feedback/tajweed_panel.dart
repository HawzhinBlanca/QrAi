/// FL6 — the learner-facing feedback surface.
///
/// ── The rule, made structural ───────────────────────────────────────────────────────────────────
/// A tajweed finding must never reach a learner without a source, a confidence, and a human
/// approval. Two layers enforce that and they are deliberately redundant:
///
/// 1. `TajweedFinding` REQUIRES reviewStatus, confidence and sources, so a payload missing any of
///    them fails to PARSE and never becomes an object at all.
/// 2. This widget filters on `isLearnerVisible` — the shared gate, term for term with
///    `canShowLearnerFacingAiOutput` in `packages/contracts` — and renders the sources and the
///    confidence ALONGSIDE every finding it shows.
///
/// The second layer is not belt-and-braces for its own sake: a learner who is shown a judgement
/// about their recitation of the Qur'an is entitled to see who stands behind it. Showing the
/// finding without its provenance is a different product than showing both.
///
/// ── Why "awaiting review" is a distinct state ───────────────────────────────────────────────────
/// Today every finding from `/v1/ml/tajweed-findings:predict` arrives `ai-suggested` and is withheld
/// (see `ApiClient.predictTajweed`). Telling a learner "no feedback" while a dozen findings sit
/// unreviewed would be false, and telling them their recitation was clean would be worse. So the
/// empty state distinguishes *nothing was found* from *nothing has been approved yet*, exactly as
/// the web panel does.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';

class TajweedPanel extends StatelessWidget {
  const TajweedPanel({super.key, required this.findings});

  final List<TajweedFinding> findings;

  @override
  Widget build(BuildContext context) {
    final List<TajweedFinding> visible =
        findings.where((TajweedFinding f) => f.isLearnerVisible).toList(growable: false);
    final int withheld = findings.length - visible.length;

    if (visible.isEmpty) {
      // Deliberately not "no mistakes found". Everything here may be awaiting review, and telling a
      // learner their recitation was clean when nobody has looked at it yet is a fabrication.
      return Padding(
        key: const ValueKey<String>('tajweed-none'),
        padding: const EdgeInsets.all(16),
        child: Text(
          withheld > 0
              ? '$withheld ${withheld == 1 ? 'note is' : 'notes are'} waiting for a teacher to '
                  'review. Nothing is shown until someone has checked it.'
              : 'No feedback for this recitation yet.',
        ),
      );
    }

    return ListView.builder(
      key: const ValueKey<String>('tajweed-list'),
      shrinkWrap: true,
      // The practice screen is itself a ListView. Two nested vertical scrollables both claiming the
      // drag is a real bug, not a lint: the inner one swallows the gesture and the outer page stops
      // scrolling once your finger is over the findings.
      physics: const NeverScrollableScrollPhysics(),
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
    // wordId+rule, not an id: findings arrive without one (services/ml-inference/tajweed.js).
    final String key = '${finding.wordId}-${finding.rule}';
    return ListTile(
      key: ValueKey<String>('finding-$key'),
      title: Row(
        children: <Widget>[
          Expanded(child: Text(finding.rule)),
          if (finding.arabicName != null)
            // Canonical text: rendered as the server sent it, never transformed, never translated.
            Text(
              finding.arabicName!,
              textDirection: TextDirection.rtl,
              style: theme.textTheme.bodyMedium,
            ),
        ],
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(finding.explanation),
          // Provenance, always, next to the finding it belongs to. A learner shown a judgement
          // about their recitation is entitled to see who stands behind it.
          for (final SourceReference s in finding.sources)
            Text(
              'Source: ${s.title} — ${s.citation}',
              key: ValueKey<String>('finding-source-$key-${s.id}'),
              style: theme.textTheme.labelSmall,
            ),
          Text(
            'Confidence: ${(finding.confidence * 100).round()}%',
            key: ValueKey<String>('finding-confidence-$key'),
            style: theme.textTheme.labelSmall,
          ),
        ],
      ),
    );
  }
}
