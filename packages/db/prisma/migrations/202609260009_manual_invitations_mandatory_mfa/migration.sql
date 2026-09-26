-- Pending links created by the former SMTP flow cannot be displayed to an Owner.
-- Expire them and erase queued ciphertext before enabling manual delivery.
UPDATE invitation
SET status = 'expired', "tokenHash" = NULL
WHERE status = 'pending';

UPDATE mail_outbox
SET payload = NULL,
    status = CASE WHEN status IN ('pending', 'processing') THEN 'cancelled' ELSE status END,
    "leaseToken" = NULL,
    "leaseUntil" = NULL
WHERE payload IS NOT NULL OR status IN ('pending', 'processing');

DELETE FROM invitation_verification;

CREATE TABLE invitation_enrollment (
 id text PRIMARY KEY,
 "invitationId" text NOT NULL UNIQUE REFERENCES invitation(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK (revision > 0),
 "tokenHash" text NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
 name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
 "passwordHash" text NOT NULL,
 "pendingCiphertext" text NOT NULL,
 "expiresAt" timestamptz(3) NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX invitation_enrollment_expiry ON invitation_enrollment("expiresAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON invitation_enrollment TO getexception_web;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 8 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 9
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
