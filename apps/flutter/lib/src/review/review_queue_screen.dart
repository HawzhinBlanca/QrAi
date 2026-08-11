/// The teacher's review queue — the Flutter counterpart of `apps/web/src/components/TeacherSurface.tsx`.
///
/// ── What a decision here actually does ─────────────────────────────────────────────────────────
/// Since ADR-0027, `create_teacher_review` promotes the finding in the same transaction as the
/// review row and the audit event:
///
///   accepted -> `teacher-reviewed`   rejected -> `blocked`   edited -> unchanged
///
/// Promotion is necessary but NOT sufficient in two separate ways, and the notice says both:
///
///  1. `canShowLearnerFacingAiOutput` also requires a source and confidence >= 0.82, so an accepted
///     but unsourced finding is still withheld — the card flags that case before it is decided.
///  2. **Nothing learner-facing reads the promoted row yet.** The learner's screen calls
///     `POST /v1/ml/tajweed-findings:predict`, which re-analyses the recitation and returns fresh
///     `ai-suggested` findings; it never reads `tajweed_findings`. Nor does production ever write
///     that table — only `0006_seed_internal.sql` does. ADR-0027 §Consequences records both gaps.
///
/// A teacher whose evening's work cannot reach anyone yet is entitled to be told so plainly.
///
/// A decided finding stays on screen for the rest of the session, showing what was recorded and its
/// audit id, rather than vanishing the instant it is tapped. On the next load it is gone:
/// `pendingForReview` excludes both approved and blocked. That is deliberate — a row that disappears
/// under your finger is how a teacher loses track of whether the tap registered.
///
/// ── Why there is no "edited" button ─────────────────────────────────────────────────────────────
/// `TeacherDecision` has three variants and this offers two. `edited` means the teacher rewrote the
/// explanation, and there is nowhere to put the rewrite: `teacher_reviews` has `note`, and nothing
/// reads a note back into the finding. An Edit button would silently discard the teacher's work,
/// which is worse than not offering it.
///
/// ── Why there is no audio (and what changed on 2026-08-11) ─────────────────────────────────────
/// This said: "The web surface fetches `/v1/recitation-sessions/{id}/audio`. That route does not
/// exist in platform-api (`grep` over `lib.rs` finds no audio route), so the web player is broken."
/// The diagnosis of the web surface was RIGHT and its player has since been fixed. The conclusion
/// drawn from it was wrong, and it is worth saying why, because the same grep will mislead the next
/// reader: platform-api DOES serve audio, at `GET /v1/tajweed-findings/{id}/audio`, and has since
/// ADR-0037. The web surface was calling the realtime GATEWAY's WebSocket path against the
/// platform-api base — the right path, the wrong service. It is now contracted
/// (`specs/flutter-client/openapi.yaml`) and reachable from here.
///
/// So a player here needs a client method and a widget, not a new route. What has NOT changed is the
/// part that matters most: whether audio exists at all is the learner's consent decision, `discard`
/// retention means there is nothing to play, and every read is audited. The four `audioStatus`
/// values must stay distinct in the UI — the web surface collapsed them into one "no audio" message
/// and made a learner's erasure look like a bug. What this must never do is imply the teacher heard
/// something they did not.
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

  /// Decisions recorded in THIS session, by finding id.
  ///
  /// The list on screen is not refetched after a decision, so this is what lets a decided card show
  /// what happened to it. Refetching instead would make the row vanish mid-tap — correct, and the
  /// fastest way for a teacher to lose track of whether the tap registered.
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
        'Accepting clears a note for learners; rejecting blocks it; editing leaves it pending. '
        'Every decision is audited. Note that learners cannot see these notes yet even once '
        'accepted — their screen re-analyses each recitation instead of reading reviewed notes. '
        'Your decisions are recorded and will apply when that is connected.',
        style: TextStyle(color: theme.colorScheme.onSecondaryContainer),
      ),
    );
  }
}

/// What to tell the teacher a decision did. Mirrors ADR-0027's mapping; a pure function so the
/// wording is asserted directly rather than through three widget pumps.
String _recordedSummary(TeacherReview review) {
  final String effect = switch (review.decision) {
    'accepted' => 'cleared for learners (sources and confidence permitting)',
    'rejected' => 'blocked',
    // Includes `edited` AND any decision string this client does not recognise: describing an
    // unknown verdict's effect would be a guess, and the audit id below is the honest pointer.
    _ => 'recorded — this note stays pending',
  };
  return 'Recorded: ${review.decision} — $effect. Audit ${review.auditEventId}.';
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
                'No source cited. Accepting is disabled: the server refuses to release a finding '
                'with nothing behind it. Reject it, or have a source added first.',
                key: ValueKey<String>('review-nosource-$key'),
                style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.error),
              ),
            const SizedBox(height: 12),
            if (recorded != null)
              Text(
                _recordedSummary(recorded),
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
                    // Disabled for a sourceless finding, matching the server's refusal
                    // (ADR-0027 item 6). Letting the button through would spend a teacher's
                    // judgement and answer 400 — the rule is knowable before they tap.
                    onPressed: widget.locked || f.sources.isEmpty
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
