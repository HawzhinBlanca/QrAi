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

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
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
  });

  final ApiClient client;
  final Uri gatewayBase;
  final String learnerId;

  /// Substitutes the real microphone+socket in a test. Null in the app, and the gate still decides
  /// whether it is ever CALLED — an override cannot bypass consent, only replace what consent lets
  /// through.
  final AudioRecorder Function(RealtimeTicket)? recorderOverride;

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
        // `record` prompts the OS itself; this is the gate's second check, after consent.
        requestMicPermission: () async => true,
      );

      // The same state the pre-check used. The gate re-evaluates it rather than trusting the check
      // above — that redundancy is the whole point of `consent_gate.dart` owning the decision.
      await gate.start(state);

      if (!mounted) return;
      setState(() {
        _gate = gate;
        _session = session;
        _status = 'Recording ${session.quranRef.display}.';
      });
    } on CaptureNotPermitted catch (e) {
      setState(() => _status = _refusalMessage(e.reason));
    } on ApiException catch (e) {
      setState(() => _status = 'Could not start: ${e.message}');
    } on Object catch (e) {
      // Includes a gateway that refused the ticket. Shown, never swallowed — a practice session
      // that silently is not recording is the failure a learner discovers only afterwards.
      setState(() => _status = 'Could not start: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop() async {
    final ConsentGatedRecorder? gate = _gate;
    if (gate == null) return;
    setState(() => _busy = true);
    try {
      await gate.stop();
      if (mounted) setState(() => _status = 'Stopped. Your recitation was sent for review.');
    } finally {
      if (mounted) {
        setState(() {
          _gate = null;
          _busy = false;
        });
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
    _gate?.stop();
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
                key: ValueKey<String>('retention-session-only'),
                value: Consent.retentionSessionOnly,
                title: Text('Keep it for this session only'),
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
