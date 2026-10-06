ALTER TABLE project ADD COLUMN "issueHistoryStartedAt" timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE release ADD COLUMN "appVersion" text;
ALTER TABLE error_event ADD COLUMN "appVersion" text;

ALTER TABLE release ADD CONSTRAINT release_app_version CHECK ("appVersion" IS NULL OR (length("appVersion") <= 64 AND "appVersion" ~ '^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$'));
ALTER TABLE error_event ADD CONSTRAINT event_app_version CHECK ("appVersion" IS NULL OR (length("appVersion") <= 64 AND "appVersion" ~ '^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$'));

-- Array comparison implements SemVer precedence, including numeric prerelease identifiers.
CREATE FUNCTION app_version_sort_key(value text) RETURNS text[] LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
  SELECT ARRAY[lpad(split_part(core, '.', 1), 10, '0'), lpad(split_part(core, '.', 2), 10, '0'),
    lpad(split_part(core, '.', 3), 10, '0'), CASE WHEN position('-' IN basic) > 0 THEN '0' ELSE '1' END]
    || CASE WHEN position('-' IN basic) = 0 THEN ARRAY[]::text[] ELSE
      ARRAY(SELECT CASE WHEN item ~ '^[0-9]+$' THEN '0' || lpad(item, 64, '0') ELSE '1' || item END
        FROM unnest(string_to_array(substring(basic FROM position('-' IN basic) + 1), '.')) WITH ORDINALITY AS identifiers(item, ord)
        ORDER BY ord) END
  FROM (SELECT split_part(value, '+', 1) AS basic, split_part(split_part(value, '+', 1), '-', 1) AS core) v;
$$;
REVOKE ALL ON FUNCTION app_version_sort_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_version_sort_key(text) TO getexception_web;

CREATE TABLE issue_history (
  id text PRIMARY KEY,
  "projectId" text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  "issueId" text REFERENCES issue(id) ON DELETE SET NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'staging', 'development')),
  "firstSeen" timestamptz(3) NOT NULL,
  "lastSeen" timestamptz(3) NOT NULL,
  "firstRelease" text CHECK (length("firstRelease") <= 160),
  "lastRelease" text CHECK (length("lastRelease") <= 160),
  "firstAppVersion" text CHECK (length("firstAppVersion") <= 64),
  "lastAppVersion" text CHECK (length("lastAppVersion") <= 64),
  "firstSeenKnown" boolean NOT NULL DEFAULT true,
  canonical boolean NOT NULL DEFAULT true,
  "firstEventId" text NOT NULL CHECK ("firstEventId" ~ '^[a-f0-9]{32}$'),
  "lastEventId" text NOT NULL CHECK ("lastEventId" ~ '^[a-f0-9]{32}$'),
  CONSTRAINT issue_history_project_boundary FOREIGN KEY ("issueId", "projectId")
    REFERENCES issue(id, "projectId") ON DELETE SET NULL ("issueId"),
  CHECK ("firstSeen" <= "lastSeen")
);
CREATE UNIQUE INDEX "issue_history_projectId_fingerprint_environment_key" ON issue_history ("projectId", fingerprint, environment);
CREATE INDEX "issue_history_issueId_environment_idx" ON issue_history ("issueId", environment);
CREATE INDEX "issue_history_projectId_firstRelease_environment_idx" ON issue_history ("projectId", "firstRelease", environment);
CREATE INDEX "issue_history_lastSeen_idx" ON issue_history ("lastSeen");

-- Retained events provide observations, but cannot prove absence in expired history.
INSERT INTO issue_history (id, "projectId", fingerprint, "issueId", environment,
  "firstSeen", "lastSeen", "firstRelease", "lastRelease", "firstSeenKnown", "firstEventId", "lastEventId")
SELECT md5(i.id || ':' || first.environment), i."projectId", i.fingerprint, i.id, first.environment,
  first."receivedAt", last."receivedAt", first.release, last.release, false, first."eventId", last."eventId"
FROM issue i
JOIN LATERAL (
  SELECT DISTINCT ON (e.environment) e.* FROM error_event e WHERE e."issueId" = i.id
  ORDER BY e.environment, e."receivedAt", e."eventId"
) first ON true
JOIN LATERAL (
  SELECT e.* FROM error_event e WHERE e."issueId" = i.id AND e.environment = first.environment
  ORDER BY e."receivedAt" DESC, e."eventId" DESC LIMIT 1
) last ON true;

CREATE FUNCTION issue_history_chronology() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
 IF (OLD."firstSeen", OLD."firstEventId") <= (NEW."firstSeen", NEW."firstEventId") THEN
  NEW."firstSeen" := OLD."firstSeen";
  NEW."firstEventId" := OLD."firstEventId";
  NEW."firstRelease" := OLD."firstRelease";
  NEW."firstAppVersion" := OLD."firstAppVersion";
  NEW."firstSeenKnown" := OLD."firstSeenKnown";
 END IF;
 IF (OLD."lastSeen", OLD."lastEventId") >= (NEW."lastSeen", NEW."lastEventId") THEN
  NEW."lastSeen" := OLD."lastSeen";
  NEW."lastEventId" := OLD."lastEventId";
  NEW."lastRelease" := OLD."lastRelease";
  NEW."lastAppVersion" := OLD."lastAppVersion";
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION issue_history_chronology() FROM PUBLIC;
CREATE TRIGGER issue_history_chronology_before BEFORE UPDATE ON issue_history
FOR EACH ROW EXECUTE FUNCTION issue_history_chronology();

GRANT SELECT ON issue_history TO getexception_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON issue_history TO getexception_worker;
REVOKE ALL ON issue_history FROM PUBLIC, getexception_ingest;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 11 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 12
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
