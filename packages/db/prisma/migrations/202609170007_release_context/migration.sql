CREATE TABLE release_deployment (
 id text PRIMARY KEY,
 "releaseId" text NOT NULL REFERENCES release(id) ON DELETE CASCADE,
 environment text NOT NULL CHECK (environment IN ('production','staging','development')),
 "reviewKey" text NOT NULL DEFAULT '' CHECK ("reviewKey" = '' OR "reviewKey" ~ '^gitlab:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$'),
 "registeredAt" timestamptz(3),
 UNIQUE ("releaseId",environment,"reviewKey"),
 CHECK ("reviewKey" = '' OR environment = 'staging')
);
CREATE INDEX "release_deployment_environment_reviewKey_idx" ON release_deployment(environment,"reviewKey");
INSERT INTO release_deployment(id,"releaseId",environment)
 SELECT gen_random_uuid()::text, r.id, e.environment FROM release r
 JOIN error_event e ON e."projectId" = r."projectId" AND e.release = r.name
 WHERE e.environment IN ('production','staging','development') GROUP BY r.id,e.environment;
GRANT SELECT,INSERT,UPDATE ON release_deployment TO getexception_web;
GRANT SELECT,INSERT ON release_deployment TO getexception_worker;
ALTER TABLE source_artifact ADD COLUMN "storageId" text;
UPDATE source_artifact SET "storageId" = id;
ALTER TABLE source_artifact ALTER COLUMN "storageId" SET NOT NULL;
ALTER TABLE source_artifact DROP CONSTRAINT "source_artifact_projectId_debugId_key";
ALTER TABLE source_artifact ADD CONSTRAINT "source_artifact_uploadId_debugId_key" UNIQUE ("uploadId","debugId");
CREATE INDEX "source_artifact_projectId_debugId_idx" ON source_artifact("projectId","debugId");
CREATE INDEX "source_artifact_storageId_idx" ON source_artifact("storageId");
CREATE OR REPLACE VIEW runtime_schema AS SELECT 6 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 7
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
