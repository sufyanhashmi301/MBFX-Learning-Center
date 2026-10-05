// `/account`'s per-learner body (ADR-125 §1, cards since ADR-155): picture and
// details, the email address, the postal address, password and two-factor.
// Progress and history moved to `/account/progress`.
//
// The ONE kind of public page that reads the session on the server (ADR-123
// §1): it renders inside the page's `<Suspense>`, so the read makes this
// subtree dynamic without making the page's shell — or any other page — so.
import { ACCOUNT_PATH } from "@repo/contracts";
import { loadLearnerProfile } from "@repo/core";
import { getPathname, redirect } from "@repo/i18n/navigation";
import { getSetting } from "@repo/settings";
import { Container } from "@repo/ui/components/container";
import { Section } from "@repo/ui/components/section";
import { EmailOff } from "../../../../_components/email-off.tsx";
import { requireLearnerSession } from "../_lib/learner-session.ts";
import { AccountMasthead } from "./account-masthead.tsx";
import { AddressPanel } from "./address-panel.tsx";
import { EmailVerificationPanel } from "./email-verification-panel.tsx";
import { ProfilePanel } from "./profile-panel.tsx";
import { SecurityPanel } from "./security-panel.tsx";

export async function ProfileContent({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const justVerified = query.verified === "1";
  // ADR-155: where Better Auth lands a completed address change.
  const justChanged = query.emailChanged === "1";
  const { userId } = await requireLearnerSession(locale, ACCOUNT_PATH, { verified: justVerified });

  const [profile, siteName] = await Promise.all([
    loadLearnerProfile(userId),
    getSetting("site.name"),
  ]);
  if (!profile) redirect({ href: "/sign-in", locale });
  const view = profile!;

  return (
    <>
      <AccountMasthead profile={view} locale={locale} titleKey="greeting" />

      <Section spacing="md">
        {/* Cards carry the page's h2s; the masthead holds the h1. */}
        <Container className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <ProfilePanel
              profile={{
                name: view.name,
                firstName: view.firstName ?? "",
                lastName: view.lastName ?? "",
                phone: view.phone ?? "",
                birthDate: view.birthDate ?? "",
                image: view.image,
              }}
            />
            <AddressPanel address={view.address} />
          </div>
          <div className="flex flex-col gap-6">
            {/* The panel prints the address inside this streamed segment
                (changes-63 #8). */}
            <EmailOff>
              <EmailVerificationPanel
                email={view.email}
                emailVerified={view.emailVerified}
                justVerified={justVerified}
                justChanged={justChanged}
                // Back to THIS panel once Better Auth has flipped the flag.
                callbackURL={`${getPathname({ href: ACCOUNT_PATH, locale })}?verified=1`}
                changeCallbackURL={`${getPathname({ href: ACCOUNT_PATH, locale })}?emailChanged=1`}
              />
            </EmailOff>
            <SecurityPanel
              hasPassword={view.hasPassword}
              twoFactorEnabled={view.twoFactorEnabled}
              issuer={siteName ?? ""}
            />
          </div>
        </Container>
      </Section>
    </>
  );
}
