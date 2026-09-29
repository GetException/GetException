import { RequiredMfaEnrollment } from "../../components/forms/RequiredMfaEnrollment";
import { AuthShell } from "../../components/forms/AuthShell";

export const dynamic = "force-dynamic";

export default function TwoFactorPage() {
  return (
    <AuthShell>
      <h1>Set up two-factor authentication</h1>
      <RequiredMfaEnrollment />
    </AuthShell>
  );
}
