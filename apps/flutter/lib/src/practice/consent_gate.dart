/// FL5 — the consent gate on microphone capture.
///
/// ── The property this file exists to make structural ────────────────────────────────────────────
/// Until consent is granted, NO recorder is constructed. Not "constructed but not started", not
/// "started and discarded" — not constructed. A recorder object that exists is one `start()` call
/// away from capturing a child's voice, and the distance between those two states is a code review
/// nobody runs at 3am.
///
/// So the recorder is created by a FACTORY that this class calls exactly once, and only after the
/// consent check passes. `test/consent_gate_test.dart` asserts the factory is never invoked before
/// consent, which is a stronger claim than asserting no audio was recorded.
library;

import 'dart:async';

/// Whatever actually captures audio. Kept abstract so the gate can be tested without a microphone,
/// and so this file has no opinion about which package does the capturing.
abstract class AudioRecorder {
  Future<void> start();
  Future<void> stop();
  Future<void> dispose();
}

typedef RecorderFactory = AudioRecorder Function();

/// Why capture is not permitted, when it is not.
enum CaptureRefusal {
  /// The learner has not granted recording consent.
  noConsent,

  /// The OS microphone permission was refused.
  micPermissionDenied,

  /// A guardian's approval is required for this learner and has not been given.
  guardianApprovalRequired,
}

class CaptureNotPermitted implements Exception {
  const CaptureNotPermitted(this.reason);
  final CaptureRefusal reason;

  @override
  String toString() => 'CaptureNotPermitted($reason)';
}

/// The consent facts a capture decision is made from.
///
/// `recordingConsent` and `guardianApproved` come from the SERVER's stored consent record, never
/// from a local toggle: the device is not the authority on what a learner agreed to, and a client
/// that decides for itself is exactly the substitution the platform-api overwrites on every ML call.
class ConsentState {
  const ConsentState({
    required this.recordingConsent,
    required this.guardianApproved,
    required this.guardianRequired,
  });

  /// The most restrictive default. A consent state that could not be loaded permits nothing.
  const ConsentState.unknown()
      : recordingConsent = false,
        guardianApproved = false,
        guardianRequired = true;

  final bool recordingConsent;
  final bool guardianApproved;
  final bool guardianRequired;
}

class ConsentGatedRecorder {
  ConsentGatedRecorder({
    required this.recorderFactory,
    required this.requestMicPermission,
  });

  /// Called EXACTLY ONCE, and only after both gates pass. Public so a test can observe that it was
  /// never invoked — which is the property this class exists to guarantee.
  final RecorderFactory recorderFactory;
  final Future<bool> Function() requestMicPermission;

  AudioRecorder? _recorder;

  /// True only while a recorder exists AND has been started.
  bool get isRecording => _recorder != null;

  /// Decide whether capture is permitted, without side effects.
  ///
  /// Separate from `start` so a UI can disable a button, explain why, and offer the consent flow —
  /// rather than letting the learner press record and receive an error.
  CaptureRefusal? refusalFor(ConsentState consent) {
    if (!consent.recordingConsent) return CaptureRefusal.noConsent;
    if (consent.guardianRequired && !consent.guardianApproved) {
      return CaptureRefusal.guardianApprovalRequired;
    }
    return null;
  }

  /// Begin capture, or throw.
  ///
  /// ORDER: consent first, THEN the OS permission prompt. Asking for the microphone before checking
  /// consent shows a system dialog to a learner who is not allowed to record at all — which reads
  /// as permission being the only thing standing in the way.
  Future<void> start(ConsentState consent) async {
    if (isRecording) return;

    final CaptureRefusal? refusal = refusalFor(consent);
    if (refusal != null) throw CaptureNotPermitted(refusal);

    if (!await requestMicPermission()) {
      throw const CaptureNotPermitted(CaptureRefusal.micPermissionDenied);
    }

    // Only here. Every early return above happens with no recorder in existence.
    final AudioRecorder recorder = recorderFactory();
    _recorder = recorder;
    try {
      await recorder.start();
    } on Object {
      // A recorder that failed to start must not be left holding the microphone.
      _recorder = null;
      await recorder.dispose();
      rethrow;
    }
  }

  Future<void> stop() async {
    final AudioRecorder? recorder = _recorder;
    if (recorder == null) return;
    _recorder = null;
    await recorder.stop();
    await recorder.dispose();
  }
}
