// The band both account pages open with (ADR-125 §1, redesigned by ADR-155):
// the learner's picture and greeting, a row of status badges (email, two-step
// verification, how they sign in, how long they have been here), and a
// profile-strength meter whose missing items link to the card that fills them.
//
// It also mounts `SessionSync`, because this is the one thing both pages
// render from the SERVER's view of the user: whatever it shows, the header
// menu is brought into line with.
import { getFormatter, getTranslations } from "next-intl/server";
import {
  CalendarDays,
  CircleCheck,
  KeyRound,
  Link2,
  MailCheck,
  MailWarning,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  ACCOUNT_PATH,
  profileCompleteness,
  type AccountProfileView,
  type ProfileCompletenessItem,
} from "@repo/contracts";
import { Link } from "@repo/i18n/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Badge } from "@repo/ui/components/badge";
import { Container } from "@repo/ui/components/container";
import { EmailOff } from "../../../../_components/email-off.tsx";
import { ProgressBar } from "@repo/ui/components/progress-bar";
import { Section } from "@repo/ui/components/section";
import { DATE_FORMAT_OPTIONS, getSiteTimeZone } from "@repo/utils";
import { SessionSync } from "./session-sync.tsx";

/** Which card fills each missing item — the `id` each `AccountCard` is given, plus `-card`. */
const ITEM_ANCHOR: Record<ProfileCompletenessItem, string> = {
  picture: "account-profile-card",
  fullName: "account-profile-card",
  phone: "account-profile-card",
  birthDate: "account-profile-card",
  address: "account-address-card",
  emailVerified: "account-email-card",
};

export async function AccountMasthead({
  profile,
  locale,
  titleKey,
}: {
  profile: AccountProfileView;
  locale: string;
  titleKey: "greeting" | "progressTitle";
}) {
  const [t, format] = await Promise.all([
    getTranslations({ locale, namespace: "account" }),
    getFormatter({ locale }),
  ]);
  const since = format.dateTime(new Date(profile.createdAt), {
    ...DATE_FORMAT_OPTIONS,
    // ADR-182: the site's timezone.
    timeZone: getSiteTimeZone(),
  });
  const completeness = profileCompleteness(profile);

  return (
    <Section spacing="sm" className="relative isolate overflow-hidden border-b">
      {/* The wash. `-z-10` under `isolate` keeps it behind the copy. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/10 via-info/5 to-success/10"
      />
      <SessionSync
        name={profile.name}
        image={profile.image}
        emailVerified={profile.emailVerified}
      />
      <Container className="grid grid-cols-1 items-center gap-6 lg:grid-cols-(--grid-main-aside-wide)">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <Avatar size="lg" className="size-20 shadow-md ring-4 ring-background">
            {profile.image && <AvatarImage src={profile.image} alt="" />}
            <AvatarFallback className="bg-primary text-xl text-primary-foreground">
              {initialsOf(profile.name)}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">
              {t(titleKey, { name: profile.name })}
            </h1>
            {/* This band renders inside a streamed segment, where no
                layout-level marker reaches (changes-63 #8). */}
            <EmailOff>
              <p className="truncate text-sm text-muted-foreground">{profile.email}</p>
            </EmailOff>
            <ul aria-label={t("status.label")} className="flex flex-wrap gap-2 pt-1">
              <li>
                {profile.emailVerified ? (
                  <Badge variant="success">
                    <MailCheck aria-hidden /> {t("status.emailVerified")}
                  </Badge>
                ) : (
                  <Badge variant="warning">
                    <MailWarning aria-hidden /> {t("unverified")}
                  </Badge>
                )}
              </li>
              {profile.hasPassword && (
                <li>
                  {profile.twoFactorEnabled ? (
                    <Badge variant="success">
                      <ShieldCheck aria-hidden /> {t("status.twoFactorOn")}
                    </Badge>
                  ) : (
                    <Badge variant="outline-warning">
                      <ShieldAlert aria-hidden /> {t("status.twoFactorOff")}
                    </Badge>
                  )}
                </li>
              )}
              <li>
                <Badge variant="info">
                  {profile.hasPassword ? <KeyRound aria-hidden /> : <Link2 aria-hidden />}
                  {profile.hasPassword ? t("status.password") : t("status.connected")}
                </Badge>
              </li>
              <li>
                <Badge variant="outline">
                  <CalendarDays aria-hidden /> {t("memberSince", { date: since })}
                </Badge>
              </li>
            </ul>
          </div>
        </div>

        <div
          data-slot="profile-completeness"
          className="flex flex-col gap-3 rounded-xl bg-card/80 p-5 ring-1 ring-foreground/10 backdrop-blur-sm"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            {completeness.missing.length === 0 ? (
              <CircleCheck aria-hidden className="size-4 text-success-interactive" />
            ) : (
              <Sparkles aria-hidden className="size-4 text-primary-interactive" />
            )}
            {t("completeness.title")}
          </p>
          <ProgressBar
            value={completeness.percent}
            total={100}
            label={t("completeness.label")}
            countLabel={
              completeness.missing.length === 0
                ? t("completeness.complete")
                : t("completeness.remaining", { count: completeness.missing.length })
            }
            percentLabel={format.number(completeness.percent / 100, { style: "percent" })}
          />
          {completeness.missing.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">{t("completeness.missing")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {completeness.missing.map((item) => (
                  <li key={item}>
                    <Badge
                      variant="pill"
                      render={<Link href={`${ACCOUNT_PATH}#${ITEM_ANCHOR[item]}`} />}
                    >
                      {t(`completeness.items.${item}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Container>
    </Section>
  );
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
