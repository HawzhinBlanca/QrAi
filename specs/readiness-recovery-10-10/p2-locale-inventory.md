# P2 Locale Capability Inventory

**Date:** 2026-07-19  
**Status:** local source and regression-test evidence only; no locale task is
ledger-complete and no release claim follows from this document.

## Scope and method

The inventory covers the normal web route, its language selector, the i18next
resources, user-visible locale claims, and the bundled Sorani verse material.
It intentionally distinguishes interface language from Quranic source text and
verse translations. A sourced Quran translation is not evidence that the
surrounding controls, privacy disclosures, errors, or teaching guidance are
understood in that language.

## Observed interface capability

`apps/web/src/locales/` contains only `en.json` (378 leaf keys). The i18next
configuration registers the other eight contract languages as empty resources
and falls back to English. Before this slice, the real-user selector offered
Arabic as `live` and Sorani as `pilot`; selecting either rendered English
interface copy while flipping the document to RTL.

| Catalog locale | Interface bundle/review evidence | Previously offered to real users | Current user-route status |
| --- | --- | --- | --- |
| `en` | Source-language `en.json`, 378 keys | Yes | Selectable |
| `ar` | No Arabic bundle or native-review record | Yes, labelled live | Not selectable |
| `ckb` | No Sorani interface bundle or native-review record | Yes, labelled pilot | Not selectable |
| `tr`, `ur`, `id`, `ms`, `fr`, `de` | No interface bundle or review record | No | Not selectable |

The catalog remains useful for declared content and future packs, but it is not
a product-readiness claim. `localeCapabilities` in
`apps/web/src/data/platform.ts` is now the policy source. Its type permits an
available non-English interface only when it declares a bundle path, key count,
native reviewer, review date, and review expiry. The source-language English exception records
its own bundle path and key count. Normal selectors consume only
`getSelectableInterfaceLanguages`, and a `?lng=` value resolves to English unless
it is selectable. Test/smoke mode retains the full catalog solely to exercise
fallback and direction behavior; it is not a product surface.

## Quranic verse-translation evidence

The application lazily loads only the `ckb-burhan-muhammad` bundle and displays
it only while the active UI locale is `ckb`. Its individual JSON files contain
39 surahs, 856 non-empty translated ayahs, and one explicitly missing ayah.
The loader/integrity test verifies each shipped file is either translated or
explicitly missing; it does **not** establish that this is a full Quran or a
reviewed Sorani interface.

There is a separate evidence discrepancy requiring Phase 3 remediation before
any count becomes a release claim: the bundle's `manifest.json` currently lists
27 surahs / 516 translated ayahs / zero missing, which does not match the 39
files / 856 translated ayahs / one missing above. The application does not read
this manifest, but it is still inaccurate provenance metadata. Do not edit the
existing source bundle in place; create a versioned data correction with an
integrity test that binds manifest and files.

## Acceptance criteria now covered

- WHEN a normal user opens the web app, THE system SHALL offer only an
  interface locale with recorded capability evidence.
- WHEN a normal user supplies an unavailable `lng` query value, THE system
  SHALL use English rather than presenting an unreviewed interface as selected.
- WHEN a locale has only Quranic verse evidence, THE system SHALL NOT present
  it as a completed interface translation.

`apps/web/src/App.smoke.test.tsx` now makes the first two claims executable in
production mode. It fails against the earlier selector and URL behavior, then
passes with the capability registry.

## Required work before R5 can pass

1. Add a pack-manifest validator and CI test that counts keys from `en.json`,
   rejects incomplete reviewed packs, and requires reviewer identity/date for
   translations.
2. Obtain real Sorani and Arabic interface packs from qualified native-language
   reviewers; do not load drafts or machine-generated strings for learners.
3. Prove RTL semantics and usability at desktop and mobile widths: focus order,
   keyboard navigation, labels, numerals, charts, errors, clipping, and
   VoiceOver/Safari plus an alternative screen reader.
4. Design a separately labelled, bounded Sorani verse-translation control if
   the product wants to expose that content before a complete Sorani interface.
   It must carry source/coverage/attribution and must never imply that the UI is
   translated.
5. In Phase 3, version and repair the translation-manifest discrepancy above,
   with a source/provenance reviewer and immutable data-release evidence.
