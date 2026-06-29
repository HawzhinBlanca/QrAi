/**
 * Browser-based ASR using the Web Speech API.
 * Provides real speech-to-text for Quran recitation alignment.
 *
 * Falls back gracefully when Web Speech API is not available
 * (e.g., Firefox), in which case the alignment service uses
 * the canonical text as the recognized text (practice mode).
 */

export type AsrStatus = "idle" | "listening" | "stopped" | "unsupported" | "error";

export interface AsrResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

export interface AsrController {
  stop: () => void;
  getStatus: () => AsrStatus;
}

export interface StartAsrOptions {
  language?: string;
  onResult: (result: AsrResult) => void;
  onStatusChange: (status: AsrStatus) => void;
  onError: (message: string) => void;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getSpeechRecognition(): { new (): SpeechRecognitionLike } | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { SpeechRecognition?: { new (): SpeechRecognitionLike } }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: { new (): SpeechRecognitionLike } }).webkitSpeechRecognition ??
    null
  );
}

export function isAsrSupported(): boolean {
  return getSpeechRecognition() !== null;
}

export function startAsr(options: StartAsrOptions): AsrController | null {
  const SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) {
    options.onStatusChange("unsupported");
    options.onError("Web Speech API is not supported in this browser. Use Chrome or Edge for live ASR.");
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = options.language ?? "ar-SA";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let status: AsrStatus = "idle";

  const updateStatus = (newStatus: AsrStatus) => {
    status = newStatus;
    options.onStatusChange(newStatus);
  };

  recognition.addEventListener("result", (event: Event) => {
    const results = (event as unknown as { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }).results;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const alternative = result[0];
      if (alternative) {
        options.onResult({
          transcript: alternative.transcript,
          confidence: alternative.confidence ?? 0.5,
          isFinal: !!(event as unknown as { resultIndex: number }).resultIndex || i === results.length - 1,
        });
      }
    }
  });

  recognition.addEventListener("error", (event: Event) => {
    const error = (event as unknown as { error?: string }).error ?? "unknown";
    updateStatus("error");
    options.onError(`Speech recognition error: ${error}`);
  });

  recognition.addEventListener("end", () => {
    if (status === "listening") {
      updateStatus("stopped");
    }
  });

  try {
    recognition.start();
    updateStatus("listening");
  } catch (error) {
    updateStatus("error");
    options.onError(`Failed to start speech recognition: ${error}`);
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      updateStatus("stopped");
    },
    getStatus: () => status,
  };
}

/**
 * Split an ASR transcript into individual words.
 * Handles Arabic text correctly (space-separated).
 */
export function splitTranscript(transcript: string): string[] {
  return transcript
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}
