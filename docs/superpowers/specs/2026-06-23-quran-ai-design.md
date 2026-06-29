# Quran AI Design

## Goal

Build the first local Quran AI product surface as a premium recitation intelligence platform, not a landing page. The app should translate the PDF pitch into a usable platform shell that can later connect to real speech recognition, Quran text, tajweed models, teacher dashboards, scholar review, model operations, and billing.

## Product Surface

The first screen is the platform command workflow:

- Left navigation for Platform Command, Learner, Teacher, Scholar, Model Ops, Trust Ledger, Quran, Lessons, Badges, Teachers, and Settings.
- Command header with language selection, human-review status, and model version.
- Learner live-alignment panel with Arabic Quran text, consent state, latency, confidence, and word-level review status.
- Intelligence pipeline, supervised agent runs, and tajweed findings with sources and review status.
- Teacher classroom metrics, scholar review queue, trust ledger, memorization plan, data flywheel, and model benchmarks.

## Architecture

Use React 19, Vite 8, TypeScript 6, Tailwind 4, Lucide icons, Motion, Recharts, and Vitest. The implementation keeps the web app in `apps/web`, shared platform contracts in `packages/contracts`, Quran sample data and platform sample data in `apps/web/src/data`, deterministic recitation and platform safety helpers in `apps/web/src/lib`, and focused UI components in `apps/web/src/components`.

The prototype simulates AI and audio locally. Real model integration should later attach behind the shared interfaces for recitation sessions, audio chunks, word alignment, tajweed classification, agent runs, teacher review, scholar approval, canonical Quran records, events, and proof gates.

## Quality Gates

- The app must run locally with `pnpm dev`.
- `pnpm test` must verify deterministic recitation helpers.
- `pnpm build` must pass typecheck and production bundling.
- Browser verification must cover desktop, mobile, visible layout, and primary interactions.
