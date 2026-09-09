-- Roles are provisioned by docker/init-db.sh, before the non-superuser migrate role runs.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER TABLE system_setting ADD CONSTRAINT system_singleton CHECK (id = 1);
ALTER TABLE bootstrap_token ADD CONSTRAINT bootstrap_singleton CHECK (id = 1);
ALTER TABLE workspace ADD CONSTRAINT workspace_singleton CHECK (singleton = 1);
ALTER TABLE member ADD CONSTRAINT member_role CHECK (role IN ('owner','developer','viewer'));
ALTER TABLE mfa_credential ADD CONSTRAINT credential_state CHECK (state IN ('pending','active'));
ALTER TABLE project ADD CONSTRAINT project_quota CHECK ("dailyQuota" BETWEEN 1 AND 100000);
ALTER TABLE event_inbox ADD CONSTRAINT inbox_state CHECK (status IN ('pending','processing','done','dead','discarded'));
ALTER TABLE event_inbox ADD CONSTRAINT inbox_payload CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1048576);
ALTER TABLE error_event ADD CONSTRAINT event_level CHECK (level IN ('error','fatal'));
ALTER TABLE error_event ADD CONSTRAINT event_environment CHECK (environment IN ('production','staging','development'));
ALTER TABLE issue ADD CONSTRAINT issue_state CHECK (status IN ('open','resolved'));

CREATE VIEW ingestion_config WITH (security_barrier = true) AS
 SELECT k.id || ':' || coalesce(o.origin, '') AS id, p.id AS "projectId", k."keyHash", o.origin, p."dailyQuota", p."allowedTags"
 FROM project p JOIN project_ingestion_key k ON k."projectId" = p.id
 LEFT JOIN project_origin o ON o."projectId" = p.id
 WHERE p.enabled AND k."revokedAt" IS NULL AND (k."expiresAt" IS NULL OR k."expiresAt" > now())
 AND EXISTS (SELECT 1 FROM system_setting WHERE id = 1);
CREATE VIEW runtime_schema AS SELECT 1 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 2
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);

CREATE TABLE admission_state (id integer PRIMARY KEY CHECK (id = 1), day date NOT NULL, accepted integer NOT NULL DEFAULT 0);
INSERT INTO admission_state(id, day) VALUES (1, CURRENT_DATE);
CREATE FUNCTION admit_inbox() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE quota integer; daily integer; installation integer;
BEGIN
 NEW."receivedAt" := clock_timestamp();
 -- Readiness uses the actual inbox in a transaction that is always rolled back.
 IF NEW."projectId" IS NULL THEN
   IF NEW."eventId" <> '00000000000000000000000000000000' OR NEW.payload <> '{}'::jsonb THEN
     RAISE EXCEPTION 'invalid_probe' USING ERRCODE = '23514';
   END IF;
   RETURN NEW;
 END IF;
 PERFORM 1 FROM admission_state WHERE id = 1 FOR UPDATE;
 IF EXISTS (SELECT 1 FROM event_inbox WHERE "projectId" = NEW."projectId" AND "eventId" = NEW."eventId") THEN RETURN NULL; END IF;
 SELECT "dailyQuota" INTO quota FROM project WHERE id = NEW."projectId" AND enabled;
 IF quota IS NULL OR NOT EXISTS (SELECT 1 FROM system_setting WHERE id = 1) THEN RAISE EXCEPTION 'ingest_disabled' USING ERRCODE = '23514'; END IF;
 UPDATE admission_state SET day = CURRENT_DATE, accepted = 0 WHERE id = 1 AND day <> CURRENT_DATE;
 SELECT accepted INTO installation FROM admission_state WHERE id = 1;
 SELECT accepted INTO daily FROM project_daily_stat WHERE "projectId" = NEW."projectId" AND day = CURRENT_DATE;
 IF installation >= 100000 OR coalesce(daily,0) >= quota OR (SELECT count(*) FROM event_inbox WHERE status IN ('pending','processing')) >= 10000 THEN
   RAISE EXCEPTION 'ingest_capacity' USING ERRCODE = '23514';
 END IF;
 UPDATE admission_state SET accepted = accepted + 1 WHERE id = 1;
 INSERT INTO project_daily_stat("projectId",day,accepted) VALUES (NEW."projectId",CURRENT_DATE,1)
 ON CONFLICT ("projectId",day) DO UPDATE SET accepted = project_daily_stat.accepted + 1;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION admit_inbox() FROM PUBLIC;
CREATE TRIGGER admit_inbox_before BEFORE INSERT ON event_inbox FOR EACH ROW EXECUTE FUNCTION admit_inbox();
-- Preserve chronology when replicas complete jobs out of order.
CREATE FUNCTION issue_chronology() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN NEW."firstSeen" := least(OLD."firstSeen",NEW."firstSeen"); NEW."lastSeen" := greatest(OLD."lastSeen",NEW."lastSeen"); RETURN NEW; END;
$$;
REVOKE ALL ON FUNCTION issue_chronology() FROM PUBLIC;
CREATE TRIGGER issue_chronology_before BEFORE UPDATE ON issue FOR EACH ROW EXECUTE FUNCTION issue_chronology();

GRANT USAGE ON SCHEMA public TO getexception_web, getexception_ingest, getexception_worker, getexception_backup;
GRANT SELECT ON runtime_schema TO getexception_web, getexception_ingest, getexception_worker, getexception_backup;
GRANT SELECT ON ingestion_config TO getexception_ingest;
GRANT INSERT (id,"projectId","eventId",payload) ON event_inbox TO getexception_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON system_setting, bootstrap_token, setup_session, "user", auth_account, session, verification, workspace, member, team, team_member, mfa_credential, recovery_code, auth_rate_bucket, project, project_team, project_origin, project_ingestion_key TO getexception_web;
GRANT SELECT ON issue, error_event, release, project_daily_stat TO getexception_web;
GRANT SELECT, INSERT ON audit_log TO getexception_web;
GRANT SELECT, UPDATE, DELETE ON event_inbox TO getexception_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON issue, error_event, release TO getexception_worker;
GRANT SELECT ON project, project_daily_stat TO getexception_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO getexception_backup;
ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO getexception_backup;
