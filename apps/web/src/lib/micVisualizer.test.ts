import { describe, expect, it } from "vitest";
import { computeBars } from "./micVisualizer";

describe("mic visualizer", () => {
  it("maps frequency data into the requested number of bars", () => {
    const data = new Uint8Array(256).fill(128);
    const bars = computeBars(data, 88);
    expect(bars).toHaveLength(88);
    // 128/255 ≈ 50%
    expect(bars.every((b) => b >= 45 && b <= 55)).toBe(true);
  });

  it("keeps a visible floor for silence and clamps to 100 for full scale", () => {
    expect(computeBars(new Uint8Array(256).fill(0), 8).every((b) => b >= 6)).toBe(true);
    expect(computeBars(new Uint8Array(256).fill(255), 8).every((b) => b === 100)).toBe(true);
  });

  it("reflects real signal variation across bars (louder bins → taller bars)", () => {
    const data = new Uint8Array(256);
    // First half loud, second half quiet.
    data.fill(255, 0, 128);
    data.fill(0, 128, 256);
    const bars = computeBars(data, 2);
    expect(bars[0]).toBeGreaterThan(bars[1]);
  });
});
