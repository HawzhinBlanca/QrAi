/// AUD1 — the practice flow: consent → session → ticket → microphone → gateway.
///
/// This is the screen the audit found missing. `consent_gate.dart` and `streaming_recorder.dart`
/// held the pieces; nothing wired them to a server or to a button.
///
/// ── The order is the safety property ────────────────────────────────────────────────────────────
/// Consent is collected and SENT before a session exists, the session is what the server scopes
/// every later ML call to, and only then is a ticket issued and a microphone opened. A screen that
/// recorded first and asked later would produce audio with no consent record attached to it — and
/// the server, which overwrites client-supplied consent with the session's stored record, would
/// have nothing to overwrite it with.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../feedback/tajweed_panel.dart';
import '../shell/load_state.dart';
import 'consent_gate.dart';
import 'streaming_recorder.dart';

/// Mirrors `apps/web/src/lib/api.ts:210` so a session reads the same wherever it was created.
const String _sourceChecksum = 'tanzil:uthmani:v1';
const String _modelVersion = 'model-v0.3';
const String _mode = 'guided-recite';

class PracticeScreen extends StatefulWidget {
  const PracticeScreen({
    super.key,
    required this.client,
    required this.gatewayBase,
    required this.learnerId,
    this.recorderOverride,
    this.micPermission = requestMicrophonePermission,
  });

  final ApiClient client;
  final Uri gatewayBase;
  final String learnerId;

  /// Substitutes the real microphone+socket in a test. Null in the app, and the gate still decides
  /// whether it is ever CALLED — an override cannot bypass consent, only replace what consent lets
  /// through.
  final AudioRecorder Function(RealtimeTicket)? recorderOverride;

  /// Asks the OS. Defaults to the REAL check — it was briefly hardcoded to `true`, which made
  /// `CaptureRefusal.micPermissionDenied` unreachable: a learner who had denied the microphone in
  /// system settings would have been told nothing and recorded nothing. A widget test passes a fake
  /// because there is no platform channel under `flutter test`.
  final Future<bool> Function() micPermission;

  @override
  State<PracticeScreen> createState() => _PracticeScreenState();
}

class _PracticeScreenState extends State<PracticeScreen> {
  // Consent starts at the most restrictive setting the contract allows. Nothing here is pre-ticked:
  // a checkbox that arrives already agreed to is not agreement.
  String _retention = Consent.retentionDiscard;
  bool _anonymizedLearning = false;
  bool _externalAsr = false;
  bool _guardianApproved = false;

  int _surah = 1;
  int _ayahStart = 1;
  int _ayahEnd = 7;

  ConsentGatedRecorder? _gate;
  RecitationSession? _session;
  String? _status;
  bool _busy = false;

  /// Feedback on the recitation that just ended. `null` means none has been recorded this session —
  /// nothing renders. Anything else renders, including a failure: a learner who is shown nothing
  /// cannot tell "no feedback" apart from "we could not fetch it", and only one of those is true.
  LoadState<List<TajweedFinding>>? _findings;

  bool get _recording => _gate?.isRecording ?? false;

  Future<void> _start() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = null;
    });
    try {
      // ── Refuse BEFORE anything is created ────────────────────────────────────────────────────
      // `refusalFor` is side-effect-free precisely so it can be asked first. Without this the flow
      // created a session AND minted a realtime ticket, then refused — leaving a valid credential
      // for the audio gateway issued to a learner who is not permitted to record. Caught by
      // `practice_screen_test.dart`'s assertion that no request is made at all.
      final ConsentState state = ConsentState(
        recordingConsent: true,
        // The client cannot know a tenant's guardian policy, so it assumes the restrictive one.
        // The form above is what satisfies it.
        guardianApproved: _guardianApproved,
        guardianRequired: true,
      );
      final CaptureRefusal? refusal = ConsentGatedRecorder(
        recorderFactory: () => throw StateError('unreachable: refusalFor constructs nothing'),
        requestMicPermission: () async => false,
      ).refusalFor(state);
      if (refusal != null) throw CaptureNotPermitted(refusal);

      // The OS prompt comes BEFORE anything is created, for the same reason the consent check comes
      // before it. A learner who declines the microphone was otherwise left with a session row
      // carrying their consent and a live gateway ticket, for a recitation that never happened —
      // the guardian bug one layer down. `consent_gate.dart`'s ordering rule is unchanged: consent
      // first, THEN the OS prompt.
      //
      // `gate.start` asks again below, and that redundancy is deliberate — the gate owns the
      // decision. `hasPermission()` returns the stored answer without re-prompting.
      if (!await widget.micPermission()) {
        throw const CaptureNotPermitted(CaptureRefusal.micPermissionDenied);
      }

      final Consent consent = Consent(
        audioRetention: _retention,
        anonymizedLearning: _anonymizedLearning,
        externalAsrProcessing: _externalAsr,
        guardianApproved: _guardianApproved,
        // Pinned by `0021_pilot_identity.sql`; the server records which text the learner agreed to.
        consentVersion: 'pilot-v1',
      );

      final RecitationSession session = await widget.client.createRecitationSession(
        learnerId: widget.learnerId,
        quranRef: QuranRef(
          surahNumber: _surah,
          ayahStart: _ayahStart,
          ayahEnd: _ayahEnd,
          display: 'Surah $_surah $_ayahStart-$_ayahEnd',
        ),
        sourceChecksum: _sourceChecksum,
        modelVersion: _modelVersion,
        language: 'ar',
        mode: _mode,
        consent: consent,
      );

      final RealtimeTicket ticket =
          await widget.client.createRealtimeTicket(sessionId: session.id);

      final ConsentGatedRecorder gate = ConsentGatedRecorder(
        recorderFactory: () =>
            widget.recorderOverride?.call(ticket) ??
            StreamingRecorder(ticket: ticket, gatewayBase: widget.gatewayBase),
        // The gate's second check, after consent — and it really asks. `record` shows the OS prompt
        // the first time and reports the stored answer afterwards.
        requestMicPermission: widget.micPermission,
      );

      // ── Ownership BEFORE the microphone can open ──────────────────────────────────────────────
      // `_gate` used to be assigned inside the setState BELOW, after `start()`. Between the two
      // sat `if (!mounted) return;`, and that was a P0: if the learner switched tabs while the
      // session and ticket calls were in flight — they SUCCEED, this is the happy path — then
      // `dispose()` ran while `_gate` was still null, so its `stop()` was a no-op; `start()` then
      // opened the microphone and the socket; and the early return dropped the only reference to
      // the recorder. A child's microphone, recording, with nothing left able to stop it.
      //
      // Assigned here, plainly and not through setState (this is not a UI change and the widget
      // may already be gone), so `dispose()` can always find it.
      _gate = gate;

      // The same state the pre-check used. The gate re-evaluates it rather than trusting the check
      // above — that redundancy is the whole point of `consent_gate.dart` owning the decision.
      await gate.start(state);

      if (!mounted) {
        // The screen went away WHILE the microphone was opening. `dispose()` has already run and
        // found a gate whose recorder did not exist yet, so its stop() did nothing. Nothing else
        // will ever stop this one.
        _gate = null;
        await gate.stop();
        return;
      }
      setState(() {
        _session = session;
        _status = 'Recording ${session.quranRef.display}.';
      });
    } on CaptureNotPermitted catch (e) {
      // `mounted` on every failure path, not just the success one. The screen is removed from the
      // tree when the learner switches tabs (`HomeShell` builds `tabs[_tab]`), so a request still
      // in flight lands on a disposed State and Flutter throws
      // "setState() called after dispose()". The success path at the top of this method already
      // returns early on `!mounted`; these three did not.
      if (mounted) setState(() => _status = _refusalMessage(e.reason));
    } on ApiException catch (e) {
      // `messageFor`, NOT `e.message`. The latter carries the transport's own words, and measured
      // against a dead server that is:
      //   request did not reach the server: ClientException with SocketException: Connection
      //   refused (OS Error: Connection refused, errno = 61), address = 127.0.0.1, port = 59493,
      //   uri=http://127.0.0.1:8083/v1/quran/surahs
      // errno, an internal address and port, in front of a child. `privacy_screen.dart` was fixed
      // for exactly this and the fix was not carried across; every learner-facing screen now goes
      // through the same mapping.
      if (mounted) setState(() => _status = 'Could not start. ${messageFor(e)}');
    } on Object catch (_) {
      // Includes a gateway that refused the ticket. Shown, never swallowed — a practice session
      // that silently is not recording is the failure a learner discovers only afterwards.
      //
      // The detail is deliberately dropped rather than interpolated: there is nowhere safe to put
      // it in a learner-facing screen, and the thing they need is that recording did not start.
      if (mounted) {
        setState(() => _status = 'Could not start. Something went wrong on this device.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop() async {
    final ConsentGatedRecorder? gate = _gate;
    // Captured before the `finally` below clears the fields, and before any await: the analysis
    // request needs this session, not whatever `_session` holds by the time the request is made.
    final RecitationSession? recorded = _session;
    if (gate == null) return;
    setState(() => _busy = true);
    try {
      await gate.stop();
      if (mounted) setState(() => _status = 'Stopped. Your recitation was sent for review.');
    } on Object {
      // Without this the success line was simply skipped and `_status` kept its last value — so the
      // button flipped back to "Start reciting" while the screen still read "Recording Surah 1 1-7",
      // and the error escaped as an unhandled async failure. A learner was told they were recording
      // when they were not.
      //
      // The microphone IS released: `ConsentGatedRecorder.stop` disposes in a `finally`. What is
      // uncertain is whether everything reached the gateway, and the message says only that.
      if (mounted) {
        setState(() => _status =
            'Recording stopped. Some of it may not have been sent — check with your teacher.');
      }
    } finally {
      if (mounted) {
        setState(() {
          _gate = null;
          _busy = false;
        });
      }
    }

    // Outside the try/finally above, deliberately. A failure to ANALYSE is not a failure to RECORD:
    // the recitation has already been sent, and folding this into the block above would let a 500
    // from the ML proxy overwrite "Stopped. Your recitation was sent for review." with a message
    // telling the learner their recording may not have arrived. It did.
    if (recorded != null) await _loadFindings(recorded);
  }

  /// Ask for the analysis of the session that just ended.
  ///
  /// Never throws: every outcome becomes a `LoadState` the panel can render. `_stop` has already
  /// completed by the time this runs, so an escaping error here would be an unhandled async failure
  /// with no way left to report it.
  Future<void> _loadFindings(RecitationSession session) async {
    if (!mounted) return;
    setState(() => _findings = const Loading<List<TajweedFinding>>());
    try {
      final List<TajweedFinding> found = await widget.client.predictTajweed(
        sessionId: session.id,
        quranRef: session.quranRef,
      );
      if (mounted) setState(() => _findings = Loaded<List<TajweedFinding>>(found));
    } on ApiException catch (e) {
      if (mounted) setState(() => _findings = Failed<List<TajweedFinding>>(e));
    } on Object {
      // A parse failure is the case that matters here: `TajweedFinding` requires reviewStatus,
      // confidence and sources precisely so a malformed finding cannot render, and this is where
      // that refusal has to land as a visible failure rather than an empty panel.
      if (mounted) {
        setState(() => _findings = Failed<List<TajweedFinding>>(
              ApiException(ApiErrorKind.server, 'feedback could not be read'),
            ));
      }
    }
  }

  static String _refusalMessage(CaptureRefusal reason) => switch (reason) {
        CaptureRefusal.noConsent => 'Recording needs your consent first.',
        CaptureRefusal.guardianApprovalRequired =>
          'A parent or guardian needs to approve recording for this learner.',
        CaptureRefusal.micPermissionDenied =>
          'The microphone permission was refused. You can change it in your device settings.',
      };

  @override
  void dispose() {
    // `dispose` cannot await, so this is fire-and-forget by necessity — but never UNHANDLED. An
    // error escaping here becomes an unhandled async failure at a moment when there is no widget
    // left to show it, and the microphone release is exactly the thing you do not want failing
    // silently. `stop()` itself now runs every release step regardless (see StreamingRecorder).
    unawaited(_gate?.stop().catchError((Object _) {}) ?? Future<void>.value());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: const ValueKey<String>('practice-screen'),
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text('What you will recite', style: Theme.of(context).textTheme.titleMedium),
        Row(
          children: <Widget>[
            Expanded(child: _NumberField(label: 'Surah', value: _surah, onChanged: (int v) => setState(() => _surah = v))),
            const SizedBox(width: 8),
            Expanded(child: _NumberField(label: 'From ayah', value: _ayahStart, onChanged: (int v) => setState(() => _ayahStart = v))),
            const SizedBox(width: 8),
            Expanded(child: _NumberField(label: 'To ayah', value: _ayahEnd, onChanged: (int v) => setState(() => _ayahEnd = v))),
          ],
        ),
        const Divider(height: 32),
        Text('Consent', style: Theme.of(context).textTheme.titleMedium),
        const Text(
          'This is sent with the session and is what the server uses for every later step. '
          'Nothing here is assumed on your behalf.',
        ),
        RadioGroup<String>(
          groupValue: _retention,
          onChanged: (String? v) => setState(() => _retention = v ?? Consent.retentionDiscard),
          child: const Column(
            children: <Widget>[
              RadioListTile<String>(
                key: ValueKey<String>('retention-discard'),
                value: Consent.retentionDiscard,
                title: Text('Discard my audio after this session'),
              ),
              RadioListTile<String>(
                key: ValueKey<String>('retention-teacher-review'),
                value: Consent.retentionTeacherReview,
                title: Text('Keep it so a teacher can review it'),
              ),
              RadioListTile<String>(
                key: ValueKey<String>('retention-training'),
                value: Consent.retentionTrainingOptIn,
                title: Text('Keep it to help improve the model'),
              ),
            ],
          ),
        ),
        SwitchListTile(
          key: const ValueKey<String>('consent-anonymized'),
          value: _anonymizedLearning,
          onChanged: (bool v) => setState(() => _anonymizedLearning = v),
          title: const Text('Allow anonymised learning'),
        ),
        SwitchListTile(
          key: const ValueKey<String>('consent-external-asr'),
          value: _externalAsr,
          onChanged: (bool v) => setState(() => _externalAsr = v),
          title: const Text('Allow processing by an external speech service'),
          subtitle: const Text('Your audio would leave our servers.'),
        ),
        SwitchListTile(
          key: const ValueKey<String>('consent-guardian'),
          value: _guardianApproved,
          onChanged: (bool v) => setState(() => _guardianApproved = v),
          title: const Text('A parent or guardian approves this'),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          key: const ValueKey<String>('practice-toggle'),
          onPressed: _busy ? null : (_recording ? _stop : _start),
          icon: Icon(_recording ? Icons.stop : Icons.mic),
          label: Text(_recording ? 'Stop' : 'Start reciting'),
        ),
        if (_status != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(_status!, key: const ValueKey<String>('practice-status')),
          ),
        if (_session != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Review status: ${_session!.reviewStatus}',
              key: const ValueKey<String>('practice-review-status'),
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ),
        // The learner-facing end of the loop. Before this the practice flow was write-only: a
        // recitation went up and nothing ever came back, so the panel and its gate had no caller.
        if (_findings != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: LoadStateView<List<TajweedFinding>>(
              key: const ValueKey<String>('practice-findings'),
              state: _findings!,
              // Only offered when there is still a session to ask about; `LoadStateView` decides on
              // its own whether a retry could plausibly help (it does not offer one on a 403).
              onRetry: _session == null ? null : () => _loadFindings(_session!),
              builder: (BuildContext _, List<TajweedFinding> found) =>
                  TajweedPanel(findings: found),
            ),
          ),
      ],
    );
  }
}

class _NumberField extends StatelessWidget {
  const _NumberField({required this.label, required this.value, required this.onChanged});

  final String label;
  final int value;
  final void Function(int) onChanged;

  @override
  Widget build(BuildContext context) => TextFormField(
        initialValue: '$value',
        decoration: InputDecoration(labelText: label),
        keyboardType: TextInputType.number,
        onChanged: (String s) {
          final int? n = int.tryParse(s);
          if (n != null && n > 0) onChanged(n);
        },
      );
}
