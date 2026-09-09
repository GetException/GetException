ALTER TABLE mfa_credential ADD COLUMN "expiresAt" timestamptz(3);

CREATE TABLE invitation (
 id text PRIMARY KEY,
 "organizationId" text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 "inviterId" text NOT NULL REFERENCES "user"(id),
 email text NOT NULL CHECK (email = lower(btrim(email))),
 role text NOT NULL CHECK (role IN ('developer','viewer')),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
 "tokenHash" text UNIQUE,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 "expiresAt" timestamptz(3) NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
 "acceptedAt" timestamptz(3)
);
CREATE UNIQUE INDEX invitation_pending_email ON invitation("organizationId",email) WHERE status = 'pending';
CREATE INDEX invitation_workspace_created ON invitation("organizationId","createdAt");
CREATE TABLE invitation_team (
 "invitationId" text NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
 "teamId" text NOT NULL REFERENCES team(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY ("invitationId","teamId")
);
CREATE TABLE invitation_verification (
 id text PRIMARY KEY,
 "invitationId" text NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 "tokenHash" text UNIQUE,
 "expiresAt" timestamptz(3) NOT NULL,
 "registrationHash" text UNIQUE,
 "registrationExpiresAt" timestamptz(3)
);
CREATE INDEX invitation_verification_invitation ON invitation_verification("invitationId");
CREATE TABLE mail_outbox (
 id text PRIMARY KEY,
 "invitationId" text NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('invitation','verification')),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 payload text CHECK (payload IS NULL OR octet_length(payload) <= 32768),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','cancelled','dead')),
 attempts integer NOT NULL DEFAULT 0,
 "nextAttemptAt" timestamptz(3) NOT NULL DEFAULT now(),
 "expiresAt" timestamptz(3) NOT NULL,
 "leaseToken" text,
 "leaseUntil" timestamptz(3),
 "lastError" text,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
 "sentAt" timestamptz(3),
 UNIQUE ("invitationId",kind)
);
CREATE INDEX mail_outbox_dispatch ON mail_outbox(status,"nextAttemptAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON invitation, invitation_team, invitation_verification, mail_outbox TO getexception_web;
GRANT USAGE ON SCHEMA public TO getexception_mail;
GRANT SELECT ON runtime_schema TO getexception_mail;
GRANT SELECT, UPDATE ON mail_outbox TO getexception_mail;

CREATE OR REPLACE VIEW runtime_schema AS SELECT 3 AS version
 WHERE (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 4
 AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
