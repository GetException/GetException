CREATE TABLE source_map_policy (
 "projectId" text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
 "bindingKey" text NOT NULL CHECK ("bindingKey" ~ '^[a-f0-9]{64}$'),
 "previewEnabled" boolean NOT NULL DEFAULT false,
 "trustedSources" jsonb NOT NULL DEFAULT '[]'::jsonb
   CHECK (jsonb_typeof("trustedSources") = 'array' AND jsonb_array_length("trustedSources") <= 20)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON source_map_policy TO getexception_web;
CREATE OR REPLACE VIEW runtime_schema AS SELECT 7 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 8
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
