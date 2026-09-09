-- Web may change workflow state, never event payloads, fingerprints or counters.
GRANT UPDATE (status, regression) ON issue TO getexception_web;

-- PostgreSQL observes the latest locked row, including a concurrent web resolve.
CREATE OR REPLACE FUNCTION issue_chronology() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 NEW."firstSeen" := least(OLD."firstSeen", NEW."firstSeen");
 NEW."lastSeen" := greatest(OLD."lastSeen", NEW."lastSeen");
 IF OLD.status = 'resolved' AND NEW.status = 'open' AND NEW."eventCount" > OLD."eventCount" THEN
   NEW.regression := true;
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE VIEW runtime_schema AS SELECT 2 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 3
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
