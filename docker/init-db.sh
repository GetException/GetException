#!/usr/bin/env bash
set -euo pipefail
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=migrate_password="$MIGRATE_PASSWORD" --set=web_password="$WEB_PASSWORD" \
  --set=ingest_password="$INGEST_PASSWORD" --set=worker_password="$WORKER_PASSWORD" \
  --set=mail_password="$MAIL_PASSWORD" --set=backup_password="$BACKUP_PASSWORD" <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE getexception_migrate LOGIN PASSWORD :'migrate_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
CREATE ROLE getexception_web LOGIN PASSWORD :'web_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30;
CREATE ROLE getexception_ingest LOGIN PASSWORD :'ingest_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
CREATE ROLE getexception_worker LOGIN PASSWORD :'worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40;
CREATE ROLE getexception_backup LOGIN PASSWORD :'backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE ROLE getexception_mail LOGIN PASSWORD :'mail_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
REVOKE ALL ON DATABASE getexception FROM PUBLIC;
GRANT CONNECT ON DATABASE getexception TO getexception_migrate, getexception_web, getexception_ingest, getexception_worker, getexception_backup, getexception_mail;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO getexception_migrate;
ALTER ROLE getexception_migrate SET statement_timeout = '60s';
ALTER ROLE getexception_web SET statement_timeout = '10s';
ALTER ROLE getexception_ingest SET statement_timeout = '3s';
ALTER ROLE getexception_worker SET statement_timeout = '15s';
ALTER ROLE getexception_backup SET statement_timeout = '10min';
ALTER ROLE getexception_web SET lock_timeout = '3s';
ALTER ROLE getexception_ingest SET lock_timeout = '1s';
ALTER ROLE getexception_worker SET lock_timeout = '3s';
ALTER ROLE getexception_migrate SET lock_timeout = '5s';
ALTER ROLE getexception_backup SET lock_timeout = '5s';
ALTER ROLE getexception_web SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE getexception_ingest SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE getexception_worker SET idle_in_transaction_session_timeout = '20s';
ALTER ROLE getexception_migrate SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE getexception_backup SET idle_in_transaction_session_timeout = '10min';
ALTER ROLE getexception_mail SET statement_timeout = '15s';
ALTER ROLE getexception_mail SET lock_timeout = '3s';
ALTER ROLE getexception_mail SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE getexception_ingest SET synchronous_commit = on;
SQL
