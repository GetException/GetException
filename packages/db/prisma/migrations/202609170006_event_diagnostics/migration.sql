ALTER TABLE error_event ADD COLUMN "apiCode" text,
 ADD COLUMN "apiReason" text,
 ADD COLUMN "httpStatus" integer,
 ADD COLUMN "browserName" text,
 ADD COLUMN "browserMajor" integer,
 ADD COLUMN "originalFrames" jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN "symbolicationState" text NOT NULL DEFAULT 'missing',
 ADD COLUMN "symbolicationVersion" integer NOT NULL DEFAULT 0;
ALTER TABLE error_event ADD CONSTRAINT event_http_status CHECK ("httpStatus" BETWEEN 100 AND 599),
 ADD CONSTRAINT event_browser_major CHECK ("browserMajor" BETWEEN 1 AND 9999),
 ADD CONSTRAINT event_api_code CHECK ("apiCode" ~ '^([a-zA-Z][a-zA-Z0-9_.-]{0,63}|[0-9]{1,6})$'),
 ADD CONSTRAINT event_api_reason CHECK ("apiReason" IN ('network_error','timeout','aborted','unauthorized','forbidden','not_found','validation_error','conflict','rate_limited','server_error')),
 ADD CONSTRAINT event_browser_name CHECK ("browserName" IN ('Chrome','Edge','Firefox','Safari','Opera','Samsung Internet')),
 ADD CONSTRAINT event_symbolication_state CHECK ("symbolicationState" IN ('missing','complete','partial','failed')),
 ADD CONSTRAINT event_original_frames CHECK (jsonb_typeof("originalFrames") = 'array' AND jsonb_array_length("originalFrames") <= 100 AND octet_length("originalFrames"::text) <= 8388608);
ALTER TABLE release ADD COLUMN "sourceMapsVersion" integer NOT NULL DEFAULT 0;
CREATE INDEX error_event_release_symbolication_idx ON error_event("projectId", release, "symbolicationVersion");

CREATE TABLE source_map_token (
 id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 "tokenHash" text NOT NULL UNIQUE, name text NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now(), "expiresAt" timestamptz(3) NOT NULL,
 "revokedAt" timestamptz(3), CHECK (length(name) BETWEEN 1 AND 80)
);
CREATE INDEX "source_map_token_projectId_idx" ON source_map_token("projectId");
CREATE TABLE source_map_upload (
 id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 release text NOT NULL, "manifestHash" text NOT NULL,
 status text NOT NULL DEFAULT 'receiving' CHECK (status IN ('receiving','pending','validating','ready','failed')),
 attempts integer NOT NULL DEFAULT 0, "leaseToken" text, "leaseUntil" timestamptz(3), "errorCode" text,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now(), "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE ("projectId", "manifestHash")
);
CREATE INDEX "source_map_upload_status_createdAt_idx" ON source_map_upload(status,"createdAt");
CREATE TABLE source_artifact (
 id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 "uploadId" text NOT NULL REFERENCES source_map_upload(id) ON DELETE CASCADE,
 release text NOT NULL, path text NOT NULL, "debugId" text NOT NULL, sha256 text NOT NULL,
 size integer NOT NULL CHECK (size BETWEEN 2 AND 16777216), "uploadedAt" timestamptz(3),
 UNIQUE ("projectId", "debugId")
);
CREATE INDEX "source_artifact_projectId_release_path_idx" ON source_artifact("projectId",release,path);
CREATE INDEX "source_artifact_uploadId_idx" ON source_artifact("uploadId");
CREATE TABLE issue_activity (
 id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 "fromIssueId" text NOT NULL, "toIssueId" text NOT NULL, "eventId" text NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX "issue_activity_projectId_fromIssueId_idx" ON issue_activity("projectId","fromIssueId");
CREATE INDEX "issue_activity_projectId_toIssueId_idx" ON issue_activity("projectId","toIssueId");
GRANT SELECT,INSERT,UPDATE,DELETE ON source_map_token,source_map_upload,source_artifact TO getexception_web;
GRANT INSERT,UPDATE ON release TO getexception_web;
GRANT SELECT,UPDATE,DELETE ON source_map_upload,source_artifact TO getexception_worker;
GRANT SELECT,INSERT,DELETE ON issue_activity TO getexception_worker;
GRANT SELECT ON issue_activity TO getexception_web;
GRANT INSERT ON audit_log TO getexception_worker;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 5 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 6
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);

CREATE OR REPLACE FUNCTION purge_deleted_project_batch() RETURNS integer
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

 DELETE FROM source_artifact WHERE id IN (SELECT id FROM source_artifact WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM source_map_upload WHERE id IN (SELECT id FROM source_map_upload WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM source_map_token WHERE id IN (SELECT id FROM source_map_token WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;
 DELETE FROM issue_activity WHERE id IN (SELECT id FROM issue_activity WHERE "projectId" = target LIMIT 500);
 GET DIAGNOSTICS removed = ROW_COUNT;
 IF removed > 0 THEN RETURN removed; END IF;

 -- Remaining small configuration tables cascade; the audit entry survives.
 DELETE FROM project WHERE id = target;
 INSERT INTO audit_log(id, action, success) VALUES (gen_random_uuid()::text, 'project_purge', true);
 RETURN 1;
END;
$$;
