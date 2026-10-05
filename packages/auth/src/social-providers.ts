// Which OAuth providers Better Auth is told about (changes-62 #4).
//
// A provider is registered only when BOTH halves of its credential are set.
// Registering one with empty strings made Better Auth log "Social provider
// google is missing clientId or clientSecret" on every boot and left a
// provider that fails at the first click. There is no OAuth UI yet, so an
// unconfigured install has no providers at all, and adding the two variables
// is the whole switch.
export interface SocialProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export type SocialProviderName = "google" | "github";

const ENV_NAMES: Record<SocialProviderName, readonly [id: string, secret: string]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
};

export function configuredSocialProviders(
  env: Record<string, string | undefined>,
): Partial<Record<SocialProviderName, SocialProviderCredentials>> {
  const out: Partial<Record<SocialProviderName, SocialProviderCredentials>> = {};
  for (const [name, [idVar, secretVar]] of Object.entries(ENV_NAMES) as [
    SocialProviderName,
    readonly [string, string],
  ][]) {
    const clientId = env[idVar]?.trim();
    const clientSecret = env[secretVar]?.trim();
    if (clientId && clientSecret) out[name] = { clientId, clientSecret };
  }
  return out;
}
