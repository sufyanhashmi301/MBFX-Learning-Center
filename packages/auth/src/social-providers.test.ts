// changes-62 #4: an empty credential registered a provider that logged a
// warning on every boot and failed at the first click.
import { describe, expect, it } from "vitest";
import { configuredSocialProviders } from "./social-providers.ts";

describe("configuredSocialProviders", () => {
  it("registers nothing when no credentials are set", () => {
    expect(configuredSocialProviders({})).toEqual({});
    expect(configuredSocialProviders({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "  " })).toEqual(
      {},
    );
  });

  it("needs both halves of a credential", () => {
    expect(configuredSocialProviders({ GITHUB_CLIENT_ID: "id" })).toEqual({});
  });

  it("registers exactly the providers that are configured", () => {
    expect(
      configuredSocialProviders({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" }),
    ).toEqual({ google: { clientId: "gid", clientSecret: "gsecret" } });
  });
});
