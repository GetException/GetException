ALTER TABLE release ADD COLUMN "lastActivityAt" timestamptz(3) NOT NULL DEFAULT now();

UPDATE release r
SET "lastActivityAt" = GREATEST(
  r."createdAt",
  COALESCE((SELECT max(e."receivedAt") FROM error_event e
            WHERE e."projectId" = r."projectId" AND e.release = r.name), r."createdAt"),
  COALESCE((SELECT max(d."registeredAt") FROM release_deployment d
            WHERE d."releaseId" = r.id), r."createdAt"),
  COALESCE((SELECT max(u."updatedAt") FROM source_map_upload u
            WHERE u."projectId" = r."projectId" AND u.release = r.name), r."createdAt")
);

CREATE INDEX "release_lastActivityAt_idx" ON release("lastActivityAt");
CREATE INDEX "session_expiresAt_idx" ON session("expiresAt");
CREATE INDEX "verification_expiresAt_idx" ON verification("expiresAt");
CREATE INDEX "invitation_status_expiresAt_idx" ON invitation(status, "expiresAt");
CREATE INDEX "mail_outbox_expiresAt_idx" ON mail_outbox("expiresAt");
CREATE INDEX "mail_outbox_status_createdAt_idx" ON mail_outbox(status, "createdAt");
CREATE INDEX "event_inbox_status_receivedAt_idx" ON event_inbox(status, "receivedAt");
CREATE INDEX "issue_lastSeen_idx" ON issue("lastSeen");
CREATE INDEX "project_daily_stat_day_idx" ON project_daily_stat(day);
CREATE INDEX "source_map_upload_status_updatedAt_idx" ON source_map_upload(status, "updatedAt");
CREATE INDEX "issue_activity_createdAt_idx" ON issue_activity("createdAt");
CREATE FUNCTION preserve_release_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."lastActivityAt" := greatest(OLD."lastActivityAt", NEW."lastActivityAt");
  RETURN NEW;
END $$;
CREATE TRIGGER release_activity_chronology BEFORE UPDATE ON release
 FOR EACH ROW EXECUTE FUNCTION preserve_release_activity();
GRANT DELETE ON project_daily_stat TO getexception_worker;

-- Runtime workers never receive direct access to credentials or invitations.
-- This fixed, bounded operation only removes records whose validity has ended.
CREATE FUNCTION purge_expired_auth_batch() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cutoff timestamptz := clock_timestamp();
BEGIN
  DELETE FROM session WHERE id IN (
    SELECT id FROM session WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM verification WHERE id IN (
    SELECT id FROM verification WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM setup_session WHERE id IN (
    SELECT id FROM setup_session WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM bootstrap_token WHERE id IN (
    SELECT id FROM bootstrap_token WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM mfa_credential WHERE id IN (
    SELECT id FROM mfa_credential
    WHERE state = 'pending' AND "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM auth_rate_bucket WHERE id IN (
    SELECT id FROM auth_rate_bucket WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM invitation_enrollment WHERE id IN (
    SELECT id FROM invitation_enrollment WHERE "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM invitation_verification WHERE id IN (
    SELECT id FROM invitation_verification
    WHERE "expiresAt" < cutoff
      AND ("registrationExpiresAt" IS NULL OR "registrationExpiresAt" < cutoff)
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  UPDATE invitation SET status = 'expired', "tokenHash" = NULL
  WHERE id IN (
    SELECT id FROM invitation
    WHERE status = 'pending' AND "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  UPDATE mail_outbox
  SET status = 'cancelled', payload = NULL, "leaseToken" = NULL, "leaseUntil" = NULL
  WHERE id IN (
    SELECT id FROM mail_outbox
    WHERE status IN ('pending', 'processing') AND "expiresAt" < cutoff
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM mail_outbox WHERE id IN (
    SELECT id FROM mail_outbox
    WHERE status IN ('sent', 'dead', 'cancelled')
      AND "createdAt" < cutoff - interval '30 days'
    ORDER BY "createdAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM recovery_code WHERE id IN (
    SELECT id FROM recovery_code
    WHERE "usedAt" < cutoff - interval '30 days'
    ORDER BY "usedAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM invitation WHERE id IN (
    SELECT id FROM invitation
    WHERE status IN ('accepted', 'expired', 'revoked')
      AND "expiresAt" < cutoff - interval '90 days'
    ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION purge_expired_auth_batch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_auth_batch() TO getexception_worker;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 9 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 10
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
