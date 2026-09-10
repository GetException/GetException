import Link from "next/link";
import type { ReactNode } from "react";
import { getRuntime } from "../../server/runtime";

// The CSP nonce is generated per request; invitation pages must hydrate with that nonce.
export const dynamic = "force-dynamic";

export default function InvitationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <div className="auth-intro">
        <Link className="brand" href="/login">
          <span className="brand-icon">∴</span>GetException
        </Link>
        <div>
          <span className="eyebrow">YOUR TEAM IS WAITING</span>
          <h1>
            Find errors.
            <br />
            Fix them together.
          </h1>
          <p>Private monitoring for your applications.</p>
        </div>
      </div>
      <section className="auth-panel">
        <span className="eyebrow">WORKSPACE INVITATION</span>
        {getRuntime().config.MAIL_ENABLED ? (
          children
        ) : (
          <p>
            Invitations are unavailable while email delivery is disabled.
            Contact the person who invited you.
          </p>
        )}
      </section>
    </main>
  );
}
