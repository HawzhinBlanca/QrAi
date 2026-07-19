// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { TajweedFinding } from "../lib/api";
import { TajweedPanel } from "./TajweedPanel";

const finding = (overrides: Partial<TajweedFinding> = {}): TajweedFinding => ({
  wordId: "1:1:1",
  rule: "Ghunnah",
  arabicName: "غنة",
  category: "ghunnah",
  severity: "warning",
  explanation: "Hold the nasalization.",
  confidence: 0.9,
  reviewStatus: "teacher-reviewed",
  sources: [{ id: "tajweed-source", title: "Tajweed reference", citation: "Rule 1" }],
  ...overrides,
});

describe("TajweedPanel learner gate", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  it("withholds a sourced but unreviewed finding instead of presenting it as learner feedback", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TajweedPanel findings={[finding({ reviewStatus: "ai-suggested" })]} />);
    });

    expect(container.querySelector(".tajweed-card")).toBeNull();
    expect(container.textContent).toContain("awaiting teacher review");
  });

  it("shows an approved finding together with its source citation", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TajweedPanel findings={[finding()]} />);
    });

    expect(container.querySelector(".tajweed-card")).toBeTruthy();
    expect(container.textContent).toContain("Tajweed reference");
    expect(container.textContent).toContain("Rule 1");
  });
});
