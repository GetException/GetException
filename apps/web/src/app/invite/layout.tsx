import type { ReactNode } from "react";
import { AuthShell } from "../../components/forms/AuthShell";

// The CSP nonce is generated per request; invitation pages must hydrate with that nonce.
export const dynamic = "force-dynamic";

export default function InvitationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <AuthShell>{children}</AuthShell>;
}
