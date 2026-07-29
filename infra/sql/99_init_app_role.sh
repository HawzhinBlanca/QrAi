#!/bin/bash
set -e
echo "Configuring restricted quran_ai_app role..."
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v app_password="$POSTGRES_PASSWORD" -f /tmp/rls-app-role.sql
echo "Restricted quran_ai_app role successfully configured."
