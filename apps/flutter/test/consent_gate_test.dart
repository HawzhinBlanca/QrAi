/// FL5 — the consent gate.
///
/// The central assertion is NOT "no audio was recorded". It is that the recorder was never
/// CONSTRUCTED. A recorder object that exists is one `start()` call away from capturing a child's
/// voice, and the distance between those two states is a code review nobody runs at 3am.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:qrai/src/practice/consent_gate.dart';

class _SpyRecorder implements AudioRecorder {
  bool started = false;
  bool stopped = false;
  bool disposed = false;
  Object? startError;

  @override
  Future<void> start() async {
    if (startError != null) throw startError!;
    started = true;
  }

  @override
  Future<void> stop() async => stopped = true;

  @override
  Future<void> dispose() async => disposed = true;
}

void main() {
  late int factoryCalls;
  late _SpyRecorder spy;
  late int micPrompts;
  late bool micGranted;

  ConsentGatedRecorder build() {
    factoryCalls = 0;
    micPrompts = 0;
    spy = _SpyRecorder();
    return ConsentGatedRecorder(
      recorderFactory: () {
        factoryCalls += 1;
        return spy;
      },
      requestMicPermission: () async {
        micPrompts += 1;
        return micGranted;
      },
    );
  }

  setUp(() => micGranted = true);

  const ConsentState granted = ConsentState(
    recordingConsent: true,
    guardianApproved: true,
    guardianRequired: true,
  );

  test('WITHOUT consent, the recorder is never CONSTRUCTED', () async {
    final ConsentGatedRecorder gate = build();
    await expectLater(
      gate.start(const ConsentState(
        recordingConsent: false,
        guardianApproved: true,
        guardianRequired: false,
      )),
      throwsA(isA<CaptureNotPermitted>()),
    );
    expect(factoryCalls, 0, reason: 'a recorder must not exist before consent is granted');
    expect(gate.isRecording, isFalse);
  });

  test('the microphone is not even REQUESTED before consent is checked', () async {
    // Asking for the mic first shows a system dialog to a learner who is not allowed to record at
    // all, which reads as permission being the only thing in the way.
    final ConsentGatedRecorder gate = build();
    await expectLater(
      gate.start(const ConsentState(
        recordingConsent: false,
        guardianApproved: false,
        guardianRequired: true,
      )),
      throwsA(isA<CaptureNotPermitted>()),
    );
    expect(micPrompts, 0, reason: 'consent is checked BEFORE the OS permission prompt');
  });

  test('guardian approval is required when the learner requires one', () async {
    final ConsentGatedRecorder gate = build();
    await expectLater(
      gate.start(const ConsentState(
        recordingConsent: true,
        guardianApproved: false,
        guardianRequired: true,
      )),
      throwsA(
        isA<CaptureNotPermitted>().having(
          (CaptureNotPermitted e) => e.reason,
          'reason',
          CaptureRefusal.guardianApprovalRequired,
        ),
      ),
    );
    expect(factoryCalls, 0);
  });

  test('an UNKNOWN consent state permits nothing', () async {
    // A consent record that could not be loaded must fail closed. Defaulting to "probably fine"
    // records a child's voice on a network error.
    final ConsentGatedRecorder gate = build();
    await expectLater(
      gate.start(const ConsentState.unknown()),
      throwsA(isA<CaptureNotPermitted>()),
    );
    expect(factoryCalls, 0);
  });

  test('a DENIED microphone permission still constructs nothing that captures', () async {
    micGranted = false;
    final ConsentGatedRecorder gate = build();
    await expectLater(
      gate.start(granted),
      throwsA(
        isA<CaptureNotPermitted>().having(
          (CaptureNotPermitted e) => e.reason,
          'reason',
          CaptureRefusal.micPermissionDenied,
        ),
      ),
    );
    expect(factoryCalls, 0, reason: 'the factory runs only after BOTH gates pass');
  });

  test('WITH consent and permission, capture starts', () async {
    final ConsentGatedRecorder gate = build();
    await gate.start(granted);
    expect(factoryCalls, 1);
    expect(spy.started, isTrue);
    expect(gate.isRecording, isTrue);
  });

  test('a recorder that FAILS to start is disposed, not left holding the microphone', () async {
    final ConsentGatedRecorder gate = build();
    spy.startError = StateError('device busy');
    await expectLater(gate.start(granted), throwsStateError);
    expect(spy.disposed, isTrue, reason: 'a half-started recorder keeps the mic open');
    expect(gate.isRecording, isFalse);
  });

  test('start is idempotent — a double tap does not open a second recorder', () async {
    final ConsentGatedRecorder gate = build();
    await gate.start(granted);
    await gate.start(granted);
    expect(factoryCalls, 1);
  });

  test('stop releases the recorder, and is safe when nothing is running', () async {
    final ConsentGatedRecorder gate = build();
    await gate.stop(); // no-op
    await gate.start(granted);
    await gate.stop();
    expect(spy.stopped, isTrue);
    expect(spy.disposed, isTrue);
    expect(gate.isRecording, isFalse);
  });

  test('refusalFor decides without side effects, so a UI can explain BEFORE the tap', () async {
    final ConsentGatedRecorder gate = build();
    expect(gate.refusalFor(granted), isNull);
    expect(
      gate.refusalFor(const ConsentState.unknown()),
      CaptureRefusal.noConsent,
      reason: 'recordingConsent is checked first, so that is the reason surfaced',
    );
    expect(factoryCalls, 0, reason: 'asking whether capture is allowed must construct nothing');
    expect(micPrompts, 0);
  });

  test('a stop() that throws still releases the microphone', () async {
    // The mirror of the start-failure guard above, which this file had and stop() did not.
    // A platform channel error on stop left dispose() unreached — a child's microphone held open
    // after they pressed Stop, with nothing in the UI saying so.
    final _ThrowsOnStop recorder = _ThrowsOnStop();
    final ConsentGatedRecorder gate = ConsentGatedRecorder(
      recorderFactory: () => recorder,
      requestMicPermission: () async => true,
    );
    await gate.start(const ConsentState(
      recordingConsent: true,
      guardianApproved: true,
      guardianRequired: false,
    ));

    await expectLater(gate.stop(), throwsA(isA<StateError>()));
    expect(recorder.disposed, isTrue, reason: 'the microphone was left held after a failed stop');
    expect(gate.isRecording, isFalse);
  });
}

/// Fails the way a platform channel does: `stop()` throws, `dispose()` still must run.
class _ThrowsOnStop implements AudioRecorder {
  bool disposed = false;

  @override
  Future<void> start() async {}
  @override
  Future<void> stop() async => throw StateError('platform channel died');
  @override
  Future<void> dispose() async => disposed = true;
}

