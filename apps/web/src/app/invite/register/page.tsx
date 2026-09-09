import { cookies } from "next/headers";
import { getRuntime } from "../../../server/runtime";
import { InvitationService } from "../../../server/invitations/service";
import { REGISTRATION_COOKIE } from "../../../server/invitations/schemas";
import { AuthError } from "../../../server/auth-error";
import { RegistrationForm } from "../../../components/invitations/RegistrationForm";

export const dynamic = "force-dynamic";

export default async function RegistrationPage() {
  try {
    const details = await new InvitationService(
      getRuntime().service,
    ).registrationDetails(
      (await cookies()).get(REGISTRATION_COOKIE)?.value ?? "",
    );

    return (
      <>
        <h2>Set up your account</h2>
        <RegistrationForm {...details} />
      </>
    );
  } catch (error) {
    if (!(error instanceof AuthError)) {
      throw error;
    }

    return (
      <p role="alert" className="alert">
        Email confirmation is required or has expired. Open your invitation
        email to request a new confirmation link.
      </p>
    );
  }
}
