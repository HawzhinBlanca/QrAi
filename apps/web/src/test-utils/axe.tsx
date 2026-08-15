import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import axe from "axe-core";

/**
 * Shared axe harness for the P6.2 accessibility audits.
 *
 * Lives outside `src/components` on purpose: `tests/contract/a11y-coverage.test.mjs` treats every
 * `.tsx` in that directory as a shipped component needing an audit of its own, and a test helper is
 * not a shipped component.
 *
 * `color-contrast` is disabled, and that is not a convenience. jsdom performs no layout and resolves
 * no stylesheet cascade, so axe cannot compute a real contrast ratio here — enabling the rule would
 * produce a verdict with nothing behind it, which is worse than no verdict. Contrast is checked
 * statically against the design tokens in `tests/contract/contrast-tokens.test.mjs`, and the
 * remaining rendered-pixel cases belong to the manual P6.2 pass that needs a real browser.
 */
export async function seriousViolations(
  node: ReactNode,
  options: { dir?: "ltr" | "rtl"; lang?: string } = {},
): Promise<string[]> {
  // React 19 warns and degrades act() without this. Set here rather than in each audit so a new
  // audit cannot forget it and silently stop flushing effects — an unflushed effect means the tree
  // axe scans is not the tree the user gets.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom implements no layout, so `scrollIntoView` does not exist on its elements. QuranReader
  // calls it to keep the verse being recited in view. This is an environment gap, NOT a product
  // defect — the method exists in every browser — but it meant the follow-along branch had never
  // been rendered by any test, accessibility or otherwise. Stubbed so it can be.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  const container = document.createElement("div");
  if (options.dir) container.dir = options.dir;
  if (options.lang) container.lang = options.lang;
  document.body.append(container);

  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });

  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });

  await act(async () => {
    root.unmount();
  });
  container.remove();

  // Report the offending markup, not just the rule id. A bare rule name sends the next reader
  // hunting through a composed surface for the one node that broke it.
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.html).join(" | ")}`);
}
