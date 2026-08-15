-- Durable, tenant-scoped single-use authority for signed realtime ticket nonces.
--
-- Only a SHA-256 digest of the signed nonce is retained. The raw ticket and raw nonce are never
-- persisted. The composite session reference makes tenant ownership structural and lets privacy
-- deletion erase replay state with its owning recitation session.

alter table recitation_sessions
  add constraint recitation_sessions_tenant_id_id_unique unique (tenant_id, id);

create table realtime_ticket_replay_claims (
  tenant_id text not null references institutions(id),
  session_id text not null,
  nonce_hash text not null,
  expires_at_unix_seconds numeric(20, 0) not null,
  claimed_at timestamptz not null default clock_timestamp(),
  constraint realtime_ticket_replay_claims_pkey
    primary key (tenant_id, session_id, nonce_hash),
  constraint realtime_ticket_replay_nonce_hash_check
    check (nonce_hash ~ '^[0-9a-f]{64}$'),
  constraint realtime_ticket_replay_expiry_check
    check (
      expires_at_unix_seconds >= 0
      and expires_at_unix_seconds <= 18446744073709551615
    ),
  constraint realtime_ticket_replay_session_fk
    foreign key (tenant_id, session_id)
    references recitation_sessions(tenant_id, id)
    on delete cascade
);

create index realtime_ticket_replay_expiry
  on realtime_ticket_replay_claims(
    tenant_id,
    expires_at_unix_seconds,
    session_id,
    nonce_hash
  );

alter table realtime_ticket_replay_claims enable row level security;
alter table realtime_ticket_replay_claims force row level security;

create policy tenant_isolation_realtime_ticket_replay_claims
  on realtime_ticket_replay_claims
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

comment on table realtime_ticket_replay_claims is
  'Tenant/session-scoped SHA-256 nonce claims for durable realtime ticket replay refusal.';
comment on column realtime_ticket_replay_claims.nonce_hash is
  'Lowercase hexadecimal SHA-256 of the signed nonce; raw tickets and nonces are forbidden.';
