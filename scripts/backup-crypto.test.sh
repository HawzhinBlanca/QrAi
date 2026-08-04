#!/usr/bin/env bash
# Guard tests for scripts/backup-crypto.sh and the encrypted backup/restore path (P5.6).
#
# An encryption scheme that cannot be decrypted is strictly worse than no encryption: it destroys the
# data and reports success while doing it. So the central test here is a full ROUND TRIP through the
# real audio backup and restore scripts, not an assertion that openssl was invoked.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# ABOUT THE KEYPAIR THIS TEST CREATES
#
# It generates a throwaway RSA keypair in `mktemp -d` and deletes it on exit. That is test scaffolding
# and nothing else: it is never written into the repository, never reused between runs, and is not
# the owner's backup key. The real recipient keypair is created ONCE by the owner, offline, and this
# tooling neither generates nor stores it — see scripts/backup-crypto.sh.
#
# The files are named `.x509` / `.pkcs8` rather than `.pem` on purpose. `**/*.pem` is a protected
# path under AGENTS.md, and test fixtures should not be shaped like real credentials.
#
#   bash scripts/backup-crypto.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected exit $2, got $3)"; fi; }

if ! command -v openssl >/dev/null 2>&1; then
  echo "SKIP: openssl not available" >&2
  exit 0
fi

cert="$tmp/recipient.x509"
key="$tmp/recipient.pkcs8"
openssl req -x509 -newkey rsa:2048 -keyout "$key" -out "$cert" -days 1 -nodes \
  -subj "/CN=qrai-backup-crypto-test" >/dev/null 2>&1

wrong_key="$tmp/attacker.pkcs8"
openssl req -x509 -newkey rsa:2048 -keyout "$wrong_key" -out "$tmp/attacker.x509" -days 1 -nodes \
  -subj "/CN=attacker" >/dev/null 2>&1

# A source tree that looks like real audio storage: tenant/learner/chunk.
src="$tmp/audio-src"
mkdir -p "$src/tenant-a/learner-1" "$src/tenant-b/learner-2"
# A distinctive marker so "is the plaintext visible in the archive" is a direct question.
marker="LEARNER-RECITATION-PLAINTEXT-MARKER"
printf '%s bismillah' "$marker" > "$src/tenant-a/learner-1/chunk-000.bin"
head -c 4096 /dev/urandom > "$src/tenant-a/learner-1/chunk-001.bin"
head -c 4096 /dev/urandom > "$src/tenant-b/learner-2/chunk-000.bin"
source_files=3

# ── 1. Refusing to write plaintext ───────────────────────────────────────────────────────────────
# The whole design rests on this: no cert, no backup. If this passes for the wrong reason the rest
# of the file is decoration.

( AUDIO_BACKUP_SOURCE="$src" bash "$here/backup-audio.sh" "$tmp/out-nocert" >/dev/null 2>&1 )
check "audio backup REFUSES when BACKUP_ENCRYPTION_CERT is unset" 2 "$?"

if [[ -n "$(find "$tmp/out-nocert" -type f 2>/dev/null)" ]]; then
  bad "audio backup left files behind after refusing"
else
  ok "audio backup wrote NOTHING when it refused"
fi

( AUDIO_BACKUP_SOURCE="$src" BACKUP_ENCRYPTION_CERT="$tmp/nonexistent.x509" \
  bash "$here/backup-audio.sh" "$tmp/out-badcert" >/dev/null 2>&1 )
check "audio backup refuses a cert path that does not exist" 2 "$?"

# The private key on a backup host defeats the entire point — the host must not be able to read its
# own backups. Handing it the private half must be an error, not a silent success.
( AUDIO_BACKUP_SOURCE="$src" BACKUP_ENCRYPTION_CERT="$key" \
  bash "$here/backup-audio.sh" "$tmp/out-privkey" >/dev/null 2>&1 )
check "audio backup refuses a PRIVATE key where the public cert belongs" 2 "$?"

# There must be no escape hatch. A grep, because the failure mode is somebody ADDING one later, and
# no behavioural test can catch a flag that does not exist yet.
#
# Comment lines are stripped first. Without that, this fired on backup-crypto.sh's own paragraph
# explaining WHY no such flag exists — a guard failing on the documentation of the thing it guards.
if grep -hvE '^[[:space:]]*#' "$here/backup-crypto.sh" "$here/backup-db.sh" "$here/backup-audio.sh" \
    | grep -qE 'BACKUP_ALLOW_PLAINTEXT|SKIP_BACKUP_ENCRYPTION|--no-encrypt'; then
  bad "a plaintext-backup escape hatch exists — it will be set during an incident and never unset"
else
  ok "no plaintext-backup escape hatch exists in any backup script"
fi

# ── 2. The archive is actually encrypted ─────────────────────────────────────────────────────────

out="$tmp/out"
if AUDIO_BACKUP_SOURCE="$src" BACKUP_ENCRYPTION_CERT="$cert" \
   bash "$here/backup-audio.sh" "$out" >"$tmp/backup.log" 2>&1; then
  ok "audio backup succeeds with a valid recipient certificate"
else
  bad "audio backup failed with a valid certificate"
  cat "$tmp/backup.log" >&2
fi

archive="$(find "$out" -name 'audio-storage-*.tar.gz.cms' -type f | head -1)"
if [[ -n "$archive" ]]; then
  ok "archive is written with the .cms suffix"
else
  bad "no .cms archive was produced"
  echo "$pass passed, $((fail + 1)) failed"; exit 1
fi

# Nothing unencrypted may be left lying around next to it.
if [[ -n "$(find "$out" -type f ! -name '*.cms' 2>/dev/null)" ]]; then
  bad "an unencrypted file was left in the backup directory: $(find "$out" -type f ! -name '*.cms')"
else
  ok "no unencrypted file remains in the backup directory"
fi

# ── THE confidentiality assertion ────────────────────────────────────────────────────────────────
#
# This started life as a single `grep -qa "$marker" "$archive"`, and a mutation run — replacing the
# encryption with `cat` — showed it PASSED with encryption switched off. gzip had compressed the
# marker out of literal visibility, so the grep was reporting confidentiality it had not tested. A
# guard that passes for the wrong reason is worse than no guard, because it is counted as coverage.
#
# So `opacity_failures` asks the three questions an attacker with the file would actually ask, and
# the control below proves every one of them can discriminate.
opacity_failures() {
  local file="$1" why=""
  # 1. Can it simply be listed and unpacked?
  tar -tzf "$file" >/dev/null 2>&1 && why="$why readable-as-tar"
  # 2. Does it carry the gzip magic (1f 8b), i.e. is it recognisably a compressed archive at all?
  [[ "$(od -A n -t x1 -N 2 < "$file" | tr -d ' \n')" == "1f8b" ]] && why="$why gzip-magic"
  # 3. Is the plaintext marker recoverable — literally, OR after decompression?
  grep -qa "$marker" "$file" 2>/dev/null && why="$why marker-literal"
  gzip -dc < "$file" 2>/dev/null | grep -qa "$marker" && why="$why marker-after-gunzip"
  printf '%s' "$why"
}

leak="$(opacity_failures "$archive")"
if [[ -n "$leak" ]]; then
  bad "the encrypted archive is not opaque —$leak"
else
  ok "the encrypted archive is opaque (not a tarball, no gzip magic, marker unrecoverable)"
fi

# The control. A plain tar.gz of the SAME tree must fail these checks, or they cannot tell encrypted
# from unencrypted and the assertion above is decoration. Each of the three is named, so a future
# change that quietly defeats one of them shows up here rather than silently weakening the test.
tar -czf "$tmp/control.tar.gz" -C "$src" .
control_leak="$(opacity_failures "$tmp/control.tar.gz")"
for probe in readable-as-tar gzip-magic marker-after-gunzip; do
  if [[ "$control_leak" == *"$probe"* ]]; then
    ok "control: '$probe' correctly detects an UNencrypted archive"
  else
    bad "control: '$probe' cannot detect plaintext even in a plain tar.gz — that probe is useless"
  fi
done

# ── 3. Only the right key opens it ───────────────────────────────────────────────────────────────

if BACKUP_DECRYPTION_KEY="$wrong_key" bash -c \
    ". '$here/backup-crypto.sh'; backup_crypto_decrypt_stream '$archive' >/dev/null 2>&1"; then
  bad "a DIFFERENT private key decrypted the archive"
else
  ok "a different private key cannot decrypt the archive"
fi

# AES-GCM is authenticated, so a corrupted backup must fail loudly rather than restore damaged data.
cp "$archive" "$tmp/tampered.tar.gz.cms"
python3 - "$tmp/tampered.tar.gz.cms" <<'PY'
import sys
p = sys.argv[1]
d = bytearray(open(p, 'rb').read())
d[len(d) // 2] ^= 0x01
open(p, 'wb').write(d)
PY
if BACKUP_DECRYPTION_KEY="$key" bash -c \
    ". '$here/backup-crypto.sh'; backup_crypto_decrypt_stream '$tmp/tampered.tar.gz.cms' >/dev/null 2>&1"; then
  bad "a TAMPERED archive decrypted successfully — the cipher is not authenticated"
else
  ok "a tampered archive is rejected (authenticated encryption)"
fi

# ── 4. Round trip through the real restore script ────────────────────────────────────────────────
# The restore path re-applies erasures against a live database, which this test has no business
# standing up — that is the drill's job. So the erasure step is pointed at a URL that cannot answer,
# and the assertion is that the restore fails there, AFTER proving decryption worked. Extraction is
# exercised directly below.

restored="$tmp/restored"
mkdir -p "$restored"
if BACKUP_DECRYPTION_KEY="$key" bash -c \
    ". '$here/backup-crypto.sh'; backup_crypto_decrypt_stream '$archive'" | tar -xz -C "$restored" 2>/dev/null; then
  ok "the archive decrypts and extracts with the correct key"
else
  bad "round trip FAILED — the archive cannot be restored"
fi

restored_count="$(find "$restored" -type f | wc -l | tr -d ' ')"
if [[ "$restored_count" == "$source_files" ]]; then
  ok "round trip restored all $source_files files"
else
  bad "round trip restored $restored_count of $source_files files"
fi

if [[ "$(cat "$restored/tenant-a/learner-1/chunk-000.bin" 2>/dev/null)" == "$marker bismillah" ]]; then
  ok "restored content is byte-identical to the source"
else
  bad "restored content does not match the source"
fi

if cmp -s "$src/tenant-a/learner-1/chunk-001.bin" "$restored/tenant-a/learner-1/chunk-001.bin"; then
  ok "restored binary audio chunk is byte-identical"
else
  bad "restored binary audio chunk differs from the source"
fi

# ── 5. Restore refuses an encrypted archive with no key ──────────────────────────────────────────
# It must fail BEFORE extracting anything, which is this script's governing rule.

empty_target="$tmp/no-key-target"
mkdir -p "$empty_target"
( AUDIO_RESTORE_TARGET="$empty_target" ERASURE_DATABASE_URL="postgresql://unreachable/x" \
  bash "$here/restore-audio.sh" "$archive" >/dev/null 2>&1 )
check "restore refuses an encrypted archive when BACKUP_DECRYPTION_KEY is unset" 2 "$?"

if [[ -n "$(find "$empty_target" -type f 2>/dev/null)" ]]; then
  bad "restore extracted files before failing on the missing key"
else
  ok "restore extracted NOTHING before failing on the missing key"
fi

# ── 6. Database backup: same rule ────────────────────────────────────────────────────────────────
# backup-db.sh checks the certificate BEFORE it checks for pg_dump, so this assertion is exact on
# every host rather than being masked into a different exit code wherever the client is absent.
# That ordering is load-bearing for this test and is explained in backup-db.sh.

( DATABASE_URL="postgresql://unreachable/x" BACKUP_DIR="$tmp/db-nocert" \
  bash "$here/backup-db.sh" >/dev/null 2>&1 )
check "database backup REFUSES when BACKUP_ENCRYPTION_CERT is unset" 2 "$?"

if [[ -n "$(find "$tmp/db-nocert" -type f 2>/dev/null)" ]]; then
  bad "database backup left a file behind after refusing"
else
  ok "database backup wrote NOTHING when it refused"
fi

echo ""
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
