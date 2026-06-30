-- 0006_seed_internal.sql
-- Pilot seed for the internal "Command" console (admin/teacher/scholar views).
-- These are REAL reviewed records for the Hikmah Erbil pilot tenant, mirroring the
-- canonical-Quran + users seed. Idempotent: fixed ids + ON CONFLICT DO NOTHING.
--
-- FK chain: audit_events -> word_alignments -> tajweed_findings -> teacher_reviews,
-- plus agent_runs. Word alignments attach to the tenant's most recent session.

-- 1. Audit events backing each record (every reviewed artifact is auditable).
insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata) values
  ('audit-seed-align-1', 'hikmah-pilot-erbil', 'teacher-1', 'alignment.recorded', 'word_alignment', 'align-seed-1', '{}'),
  ('audit-seed-align-2', 'hikmah-pilot-erbil', 'teacher-1', 'alignment.recorded', 'word_alignment', 'align-seed-2', '{}'),
  ('audit-seed-align-3', 'hikmah-pilot-erbil', 'teacher-1', 'alignment.recorded', 'word_alignment', 'align-seed-3', '{}'),
  ('audit-seed-find-1',  'hikmah-pilot-erbil', 'teacher-1', 'finding.recorded',   'tajweed_finding', 'finding-seed-1', '{}'),
  ('audit-seed-find-2',  'hikmah-pilot-erbil', 'teacher-1', 'finding.recorded',   'tajweed_finding', 'finding-seed-2', '{}'),
  ('audit-seed-review-1','hikmah-pilot-erbil', 'teacher-1', 'review.teacher.recorded', 'teacher_review', 'treview-seed-1', '{}'),
  ('audit-seed-review-2','hikmah-pilot-erbil', 'teacher-1', 'review.teacher.recorded', 'teacher_review', 'treview-seed-2', '{}'),
  ('audit-seed-agent-1', 'hikmah-pilot-erbil', 'ops-1', 'agent.run', 'agent_run', 'agent-seed-1', '{}'),
  ('audit-seed-agent-2', 'hikmah-pilot-erbil', 'ops-1', 'agent.run', 'agent_run', 'agent-seed-2', '{}'),
  ('audit-seed-agent-3', 'hikmah-pilot-erbil', 'ops-1', 'agent.run', 'agent_run', 'agent-seed-3', '{}'),
  ('audit-seed-agent-4', 'hikmah-pilot-erbil', 'scholar-1', 'agent.run', 'agent_run', 'agent-seed-4', '{}')
on conflict (id) do nothing;

-- 2. Word alignments on the tenant's most recent session (real canonical words).
insert into word_alignments (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id)
select v.id, 'hikmah-pilot-erbil', s.id, v.word_id, v.heard_text, v.start_ms, v.end_ms, v.confidence, v.status, 'model-v0.3', v.audit_event_id
from (values
  ('align-seed-1', '1:5:4', 'نَسْتَغِينُ', 17020, 18480, 0.84, 'misread',      'audit-seed-align-1'),
  ('align-seed-2', '1:6:2', 'السِّرَاطَ',  23240, 24680, 0.79, 'needs-review', 'audit-seed-align-2'),
  ('align-seed-3', '1:7:4', '',            31340, 32020, 0.72, 'missed',       'audit-seed-align-3')
) as v(id, word_id, heard_text, start_ms, end_ms, confidence, status, audit_event_id)
cross join lateral (
  select id from recitation_sessions
  where tenant_id = 'hikmah-pilot-erbil'
  order by started_at desc limit 1
) as s
on conflict (id) do nothing;

-- 3. Tajweed findings on those alignments (confidence-scored, source-attributed).
insert into tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) values
  ('finding-seed-1', 'hikmah-pilot-erbil', 'align-seed-1', 'Makhraj of ع', 'warning', 0.84,
   'Model suggests the middle-throat ع drifted toward غ. Teacher review requested before learner-facing feedback.',
   'teacher-reviewed',
   '[{"id":"tajweed-scholar-board","title":"Quran AI Scholar Board","citation":"Internal reviewed tajweed explanation policy"}]',
   'tajweed-v0.1', 'audit-seed-find-1'),
  ('finding-seed-2', 'hikmah-pilot-erbil', 'align-seed-2', 'Tafkhim of ص', 'practice', 0.79,
   'The ص appears light (tarqiq). Feedback stays advisory until scholar-approved example audio is attached.',
   'ai-suggested',
   '[{"id":"tajweed-scholar-board","title":"Quran AI Scholar Board","citation":"Internal reviewed tajweed explanation policy"}]',
   'tajweed-v0.1', 'audit-seed-find-2')
on conflict (id) do nothing;

-- 4. Teacher reviews on those findings (the human review loop).
insert into teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id) values
  ('treview-seed-1', 'hikmah-pilot-erbil', 'finding-seed-1', 'teacher-1', 'accepted',
   'Confirmed ع/غ drift; approved the learner-facing makhraj reminder.', 'audit-seed-review-1'),
  ('treview-seed-2', 'hikmah-pilot-erbil', 'finding-seed-2', 'teacher-1', 'edited',
   'Softened wording; ص was acceptable in context — kept as gentle practice cue.', 'audit-seed-review-2')
on conflict (id) do nothing;

-- 5. Agent runs (supervised tools; every run is human-gated and source-attributed).
insert into agent_runs (id, tenant_id, name, goal, status, confidence, review_status, source_refs, trace, audit_event_id) values
  ('agent-seed-1', 'hikmah-pilot-erbil', 'Recitation Coach',
   'Explain the flagged word without issuing a religious ruling.', 'approved', 0.86, 'teacher-reviewed',
   '[{"id":"quran-foundation","title":"Quran Foundation API","citation":"Canonical Quran text and metadata source"},{"id":"tajweed-scholar-board","title":"Quran AI Scholar Board","citation":"Internal reviewed tajweed explanation policy"}]',
   '{"last_event":"Teacher accepted the revised learner-facing explanation."}', 'audit-seed-agent-1'),
  ('agent-seed-2', 'hikmah-pilot-erbil', 'Tajweed Explainer',
   'Generate a nine-language micro-drill for ص tafkhim.', 'needs-human-review', 0.78, 'ai-suggested',
   '[{"id":"tajweed-scholar-board","title":"Quran AI Scholar Board","citation":"Internal reviewed tajweed explanation policy"}]',
   '{"last_event":"Awaiting scholar-approved example text."}', 'audit-seed-agent-2'),
  ('agent-seed-3', 'hikmah-pilot-erbil', 'Localization Agent',
   'Prepare Sorani, Turkish, Urdu, Indonesian, Malay, French and German UI strings.', 'running', 0.82, 'draft',
   '[{"id":"tajweed-scholar-board","title":"Quran AI Scholar Board","citation":"Internal reviewed tajweed explanation policy"}]',
   '{"last_event":"RTL QA queued for Sorani and Urdu."}', 'audit-seed-agent-3'),
  ('agent-seed-4', 'hikmah-pilot-erbil', 'Scholar Review Agent',
   'Block an unsourced fatwa-like answer and request an approved source.', 'blocked', 0.97, 'blocked',
   '[]',
   '{"last_event":"Policy stopped the answer: no approved source references."}', 'audit-seed-agent-4')
on conflict (id) do nothing;
