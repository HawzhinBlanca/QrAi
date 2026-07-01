/**
 * Live microphone visualizer — drives the recording waveform from the REAL mic signal
 * via the Web Audio API (AnalyserNode), so the bars actually move with the reciter's
 * voice instead of showing a static decorative pattern.
 */

export type MicVisualizerStop = () => void;

/** Map an AnalyserNode's frequency data into `barCount` normalized bar heights (0-100). */
export function computeBars(frequencyData: Uint8Array, barCount: number): number[] {
  const bars: number[] = [];
  const binsPerBar = Math.max(1, Math.floor(frequencyData.length / barCount));
  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    const start = i * binsPerBar;
    for (let j = 0; j < binsPerBar; j++) {
      sum += frequencyData[start + j] ?? 0;
    }
    const avg = sum / binsPerBar; // 0-255
    // Emphasize the low-mid band where speech energy sits, clamp to a visible floor.
    const pct = Math.round((avg / 255) * 100);
    bars.push(Math.max(6, Math.min(100, pct)));
  }
  return bars;
}

export function isMicVisualizerSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== "undefined"
  );
}

/**
 * Start visualizing the microphone. Calls `onBars` (~60fps) with live bar heights until
 * the returned stop function is called. Resolves to null if unsupported or mic denied.
 */
export async function startMicVisualizer(
  onBars: (bars: number[]) => void,
  barCount = 88,
): Promise<MicVisualizerStop | null> {
  if (!isMicVisualizerSupported()) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }

  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const buffer = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(buffer);
    onBars(computeBars(buffer, barCount));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void audioCtx.close();
  };
}
