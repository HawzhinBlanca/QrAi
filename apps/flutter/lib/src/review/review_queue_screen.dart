/// The teacher's review queue — the Flutter counterpart of `apps/web/src/components/TeacherSurface.tsx`.
///
/// ── What a decision here actually does, today ───────────────────────────────────────────────────
/// It writes a row in `teacher_reviews` and an audit event. It does **not** change the finding's
/// `reviewStatus`: nothing in platform-api updates `tajweed_findings` (verified —
/// `grep "UPDATE tajweed_findings" services/platform-api/src` returns nothing), and no database
/// trigger does it either. So an accepted finding stays `ai-suggested`, stays below
/// `canShowLearnerFacingAiOutput`, and the learner keeps seeing "waiting for a teacher to review".
///
/// `docs/readiness/TRUE_READINESS.md` already records this: "a learner gets the *scaffold*, not the
/// *coach*". This screen therefore does two things that a normal review console would not:
///
///   * it says so, once, at the top — a teacher spending an evening on this queue is entitled to
///     know their decisions are not yet reaching anyone; and
///   * a reviewed finding STAYS in the queue, showing the decision that was recorded against it.
///     Removing it would be the more satisfying interaction and a false one: as far as the platform
///     is concerned the finding is still unreviewed, and a refresh would bring it back anyway.
///
/// ── Why there is no "edited" button ─────────────────────────────────────────────────────────────
/// `TeacherDecision` has three variants and this offers two. `edited` means the teacher rewrote the
/// explanation, and there is nowhere to put the rewrite: `teacher_reviews` has `note`, and nothing
/// reads a note back into the finding. An Edit button would silently discard the teacher's work,
/// which is worse than not offering it.
///
/// ── Why there is no audio ───────────────────────────────────────────────────────────────────────
/// The web surface fetches `/v1/recitation-sessions/{id}/audio`. That route does not exist in
/// platform-api (`grep` over `lib.rs` finds no audio route), so the web player is broken. Beyond
/// that, whether audio exists at all is the learner's consent decision — `discard` retention means
/// there is nothing to play. Adding a player here would need a route, a retention rule, and a
/// dependency; what it must not do is imply the teacher heard something they did not.
library;

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../auth/actor.dart';
import '../shell/load_state.dart';

/// Findings still waiting on a human.
///
/// Not a denylist of "done" states: anything already cleared for a learner, or explicitly blocked,
/// is finished work. Everything else — `draft`, `ai-suggested`, `teacher-review-required`, and any
/// status added upstream that nobody taught this client about — is pending, which is the direction
/// that shows a teacher too much rather than too little.
List<TajweedFinding> pendingForReview(List<TajweedFinding> all) => all
    .where((TajweedFinding f) =>
        !learnerApprovedReviewStatuses.contains(f.reviewStatus) && f.reviewStatus != 'blocked')
    .toList(growable: false);

class ReviewQueueScreen extends StatefulWidget {
  const ReviewQueueScreen({super.key, required this.client, required this.actor});

  final ApiClient client;
  final Actor actor;

  @override
  State<ReviewQueueScreen> createState() => _ReviewQueueScreenState();
}

class _ReviewQueueScreenState extends State<ReviewQueueScreen> {
  LoadState<List<TajweedFinding>> _queue = const Loading<List<TajweedFinding>>();

  /// Decisions recorded in THIS session, by finding id. The server will not reflect them (see the
  /// library comment), so holding them here is the only way the screen can show a teacher what they
  /// have already done without claiming the finding's status changed.
  final Map<String, TeacherReview> _recorded = <String, TeacherReview>{};

  /// The finding currently being submitted, so only its own buttons disable.
  String? _submitting;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _queue = const Loading<List<TajweedFinding>>());
    try {
      final List<TajweedFinding> found = await widget.client.listTajweedFindings();
      if (mounted) setState(() => _queue = Loaded<List<TajweedFinding>>(found));
    } on ApiException catch (e) {
      if (mounted) setState(() => _queue = Failed<List<TajweedFinding>>(e));
    } on Object {
      if (mounted) {
        setState(() => _queue = Failed<List<TajweedFinding>>(
              ApiException(ApiErrorKind.server, 'the review queue could not be read'),
            ));
      }
    }
  }

  Future<void> _decide(TajweedFinding finding, TeacherDecision decision, String note) async {
    final String? id = finding.id;
    // Structurally unreachable — the buttons are only built for a finding that can be reviewed —
    // but force-unwrapping here would turn a future regression into a crash on a teacher's phone.
    if (id == null || _submitting != null) return;

    setState(() {
      _submitting = id;
      _error = null;
    });
    try {
      final TeacherReview review = await widget.client.submitTeacherReview(
        findingId: id,
        // Ignored by the server, which uses the authenticated actor. Sent because the wire struct
        // requires the field; sending the caller's own id keeps it from being a lie.
        teacherId: widget.actor.userId,
        decision: decision,
        note: note,
      );
      if (mounted) setState(() => _recorded[id] = review);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = messageFor(e));
    } on Object {
      if (mounted) setState(() => _error = 'The decision was not recorded.');
    } finally {
      if (mounted) setState(() => _submitting = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return LoadStateView<List<TajweedFinding>>(
      key: const ValueKey<String>('review-queue'),
      state: _queue,
      onRetry: _load,
      builder: (BuildContext context, List<TajweedFinding> all) {
        final List<TajweedFinding> pending = pendingForReview(all);
        return ListView(
          key: const ValueKey<String>('review-list'),
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            const _WhatThisDoesNotice(),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error!,
                  key: const ValueKey<String>('review-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (pending.isEmpty)
              const Padding(
                key: ValueKey<String>('review-empty'),
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Text('Nothing is waiting for review.'),
              )
            else
              for (final TajweedFinding f in pending)
                _FindingCard(
                  finding: f,
                  recorded: f.id == null ? null : _recorded[f.id],
                  busy: _submitting == f.id,
                  // Disabled while ANY submission is in flight, so a teacher cannot start a second
                  // decision against a queue that is about to change under them.
                  locked: _submitting != null,
                  onDecide: (TeacherDecision d, String note) => _decide(f, d, note),
                ),
          ],
        );
      },
    );
  }
}

class _WhatThisDoesNotice extends StatelessWidget {
  const _WhatThisDoesNotice();

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      key: const ValueKey<String>('review-notice'),
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        'Decisions are recorded and audited, but they do not yet release feedback to the learner — '
        'the platform does not change a finding’s status when you review it. Your work is saved; '
        'the learner still sees “waiting for a teacher to review”.',
        style: TextStyle(color: theme.colorScheme.onSecondaryContainer),
      ),
    );
  }
}

class _FindingCard extends StatefulWidget {
  const _FindingCard({
    required this.finding,
    required this.recorded,
    required this.busy,
    required this.locked,
    required this.onDecide,
  });

  final TajweedFinding finding;
  final TeacherReview? recorded;
  final bool busy;
  final bool locked;
  final void Function(TeacherDecision, String) onDecide;

  @override
  State<_FindingCard> createState() => _FindingCardState();
}

class _FindingCardState extends State<_FindingCard> {
  final TextEditingController _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final TajweedFinding f = widget.finding;
    final ThemeData theme = Theme.of(context);
    final String key = f.id ?? '${f.wordId}-${f.rule}';
    final TeacherReview? recorded = widget.recorded;

    return Card(
      key: ValueKey<String>('review-finding-$key'),
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                // Canonical text: rendered as sent, never transformed, never translated.
                Expanded(child: Text(f.rule, style: theme.textTheme.titleMedium)),
                if (f.arabicName != null)
                  Text(f.arabicName!, textDirection: TextDirection.rtl),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              '${f.severity} · ${(f.confidence * 100).round()}% · ${f.wordId} · ${f.reviewStatus}',
              key: ValueKey<String>('review-meta-$key'),
              style: theme.textTheme.labelSmall,
            ),
            const SizedBox(height: 8),
            Text(f.explanation),
            const SizedBox(height: 8),
            // Provenance, always. A teacher is being asked to stand behind this; they get to see
            // what it stands on first.
            for (final SourceReference s in f.sources)
              Text(
                '${s.title} — ${s.citation}',
                key: ValueKey<String>('review-source-$key-${s.id}'),
                style: theme.textTheme.labelSmall,
              ),
            if (f.sources.isEmpty)
              Text(
                'No source cited. A finding with nothing behind it cannot be released to a learner '
                'even if you accept it.',
                key: ValueKey<String>('review-nosource-$key'),
                style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.error),
              ),
            const SizedBox(height: 12),
            if (recorded != null)
              Text(
                'Recorded: ${recorded.decision}. Audit ${recorded.auditEventId}. '
                'The finding’s status is unchanged.',
                key: ValueKey<String>('review-recorded-$key'),
                style: TextStyle(color: theme.colorScheme.primary),
              )
            else if (!f.canBeReviewed)
              Text(
                'This finding was computed on the fly and has no id, so no decision can be recorded '
                'against it.',
                key: ValueKey<String>('review-unreviewable-$key'),
                style: theme.textTheme.labelSmall,
              )
            else ...<Widget>[
              TextField(
                key: ValueKey<String>('review-note-$key'),
                controller: _note,
                decoration: const InputDecoration(
                  labelText: 'Note (optional)',
                  border: OutlineInputBorder(),
                ),
                maxLines: 2,
              ),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  FilledButton(
                    key: ValueKey<String>('review-accept-$key'),
                    onPressed: widget.locked
                        ? null
                        : () => widget.onDecide(TeacherDecision.accepted, _note.text),
                    child: const Text('Accept'),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    key: ValueKey<String>('review-reject-$key'),
                    onPressed: widget.locked
                        ? null
                        : () => widget.onDecide(TeacherDecision.rejected, _note.text),
                    child: const Text('Reject'),
                  ),
                  if (widget.busy) ...<Widget>[
                    const SizedBox(width: 12),
                    const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
