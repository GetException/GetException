ALTER TABLE project ADD COLUMN "deletedAt" timestamptz(3);
ALTER TABLE project ADD CONSTRAINT deleted_project_disabled CHECK ("deletedAt" IS NULL OR NOT enabled);
CREATE INDEX "project_deletedAt_idx" ON project("deletedAt");

CREATE OR REPLACE VIEW ingestion_config WITH (security_barrier = true) AS
 SELECT k.id || ':' || coalesce(o.origin, '') AS id, p.id AS "projectId", k."keyHash", o.origin, p."dailyQuota", p."allowedTags"
 FROM project p JOIN project_ingestion_key k ON k."projectId" = p.id
 LEFT JOIN project_origin o ON o."projectId" = p.id
 WHERE p.enabled AND p."deletedAt" IS NULL AND k."revokedAt" IS NULL AND (k."expiresAt" IS NULL OR k."expiresAt" > now())
 AND EXISTS (SELECT 1 FROM system_setting WHERE id = 1);

-- Recoverable deleted projects must not block admission to active projects.
CREATE OR REPLACE FUNCTION admit_inbox() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
 IF installation >= 100000 OR coalesce(daily,0) >= quota OR (SELECT count(*) FROM event_inbox i JOIN project p ON p.id = i."projectId" WHERE i.status IN ('pending','processing') AND p."deletedAt" IS NULL) >= 10000 THEN
   RAISE EXCEPTION 'ingest_capacity' USING ERRCODE = '23514';
 END IF;
 UPDATE admission_state SET accepted = accepted + 1 WHERE id = 1;
 INSERT INTO project_daily_stat("projectId",day,accepted) VALUES (NEW."projectId",CURRENT_DATE,1)
 ON CONFLICT ("projectId",day) DO UPDATE SET accepted = project_daily_stat.accepted + 1;
 RETURN NEW;
END;
$$;

-- Only retention can purge, only after seven days, and only in bounded batches.
-- No arbitrary project id or clock is accepted from a runtime role.
CREATE FUNCTION purge_deleted_project_batch() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target text; removed integer;
BEGIN
 SELECT id INTO target FROM project
 WHERE "deletedAt" <= clock_timestamp() - interval '7 days'
 ORDER BY "deletedAt", id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF target IS NULL THEN RETURN 0; END IF;

 DELETE FROM error_event WHERE id IN (SELECT id FROM error_event WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM event_inbox WHERE id IN (SELECT id FROM event_inbox WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM issue WHERE id IN (SELECT id FROM issue WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM release WHERE id IN (SELECT id FROM release WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;

 -- Remaining small configuration tables cascade; the audit entry survives.
 DELETE FROM project WHERE id = target;
 INSERT INTO audit_log(id, action, success) VALUES (gen_random_uuid()::text, 'project_purge', true);
 RETURN 1;
END;
$$;
REVOKE ALL ON FUNCTION purge_deleted_project_batch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_deleted_project_batch() TO getexception_worker;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 4 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 5
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
