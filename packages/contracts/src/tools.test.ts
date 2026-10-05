// The tools registry's drift guard (ADR-086), in `learn.test.ts`'s shape.
//
// Two registries must never disagree: TOOL_KEYS decides which tools exist,
// ROUTE_PATHS decides which URLs exist. A tool added without its route key —
// or a `tool-*` route key added without its tool — fails here rather than at
// runtime, as a menu row pointing at a 404 or a page nothing links to.
import { describe, expect, it } from "vitest";

import {
  CORRELATION_WINDOWS,
  PIVOT_INTERVALS,
  TOOLS,
  TOOL_CONFIG_SCHEMAS,
  TOOL_KEYS,
  TOOL_ROUTE_KEYS,
  correlationConfigSchema,
  currencyConverterConfigSchema,
  isToolKey,
  marginConfigSchema,
  marketHoursConfigSchema,
  parseToolConfig,
  pivotPointsConfigSchema,
  profitLossConfigSchema,
  riskRewardConfigSchema,
  riskSentimentConfigSchema,
  saveToolSchema,
  toolConfigSchema,
  toolPath,
} from "./tools.ts";
import { ROUTE_PATHS } from "./index.ts";

describe("TOOL_KEYS registry", () => {
  it("registers eleven tools: the reference's eight and changes-41's three", () => {
    expect(TOOL_KEYS).toHaveLength(11);
    expect(new Set(TOOL_KEYS).size).toBe(11);
    expect(TOOL_KEYS).toEqual(expect.arrayContaining(["margin", "profit-loss", "risk-reward"]));
  });

  it("gives every key a spec whose own key matches its entry", () => {
    for (const key of TOOL_KEYS) {
      expect(TOOLS[key], `no spec for "${key}"`).toBeDefined();
      expect(TOOLS[key].key).toBe(key);
    }
  });

  it("gives every tool a route key, a config schema and an icon", () => {
    for (const key of TOOL_KEYS) {
      expect(TOOL_ROUTE_KEYS[key], `tool "${key}" has no route key`).toBeDefined();
      expect(ROUTE_PATHS[TOOL_ROUTE_KEYS[key]], `route key for "${key}" has no path`).toBeDefined();
      expect(TOOL_CONFIG_SCHEMAS[key], `tool "${key}" has no config schema`).toBeDefined();
      expect(TOOLS[key].icon.length, `tool "${key}" has no icon`).toBeGreaterThan(0);
    }
  });

  it("makes every tool's path /tools/<key> — the segment IS the key", () => {
    // ADR-086 #3. There is no slug column, so this is not a convention that
    // could drift at runtime; it is a fact the test pins so a route key
    // renamed by hand cannot quietly point somewhere else.
    for (const key of TOOL_KEYS) {
      expect(toolPath(key)).toBe(`/tools/${key}`);
    }
  });

  it("registers no tool-* route key for an unregistered tool", () => {
    const registered = new Set<string>(TOOL_KEYS);
    for (const routeKey of Object.keys(ROUTE_PATHS)) {
      const match = /^tool-(.+)$/.exec(routeKey);
      if (!match) continue;
      expect(registered.has(match[1]!), `route key "${routeKey}" names no registered tool`).toBe(
        true,
      );
    }
  });

  it("keeps the tool index route separate from the tool routes", () => {
    // "tools" is the index; the regex above must not swallow it.
    expect(ROUTE_PATHS.tools).toBe("/tools");
    expect(isToolKey("tools")).toBe(false);
  });

  it("narrows a known key and rejects an unknown one", () => {
    expect(isToolKey("pip-value")).toBe(true);
    expect(isToolKey("margin")).toBe(true);
    expect(isToolKey("live-rates")).toBe(false);
  });

  it("declares what each tool needs, and five need nothing", () => {
    // The five that need no provider at all are why T6 can ship ahead of the
    // market platform (ADR-087) — and why an instance with no key is not a
    // broken site.
    const none = TOOL_KEYS.filter((k) => TOOLS[k].needs === "none");
    expect(none).toEqual(["gain-loss", "market-hours"]);
    for (const key of TOOL_KEYS) {
      expect(["none", "rates", "history"]).toContain(TOOLS[key].needs);
    }
  });
});

describe("tool config schemas", () => {
  it("returns the same schema through the accessor as through the map", () => {
    for (const key of TOOL_KEYS) {
      expect(toolConfigSchema(key)).toBe(TOOL_CONFIG_SCHEMAS[key]);
    }
  });

  it("offers 1D/1W/1M/1Y and nothing intraday", () => {
    // The store is daily bars (ADR-087 #2). 1Y folds them exactly as 1W and
    // 1M do; a 4h interval would need data that does not exist.
    expect(PIVOT_INTERVALS).toEqual(["1D", "1W", "1M", "1Y"]);
    expect(
      pivotPointsConfigSchema.safeParse({
        intervals: ["4h"],
        defaultInterval: "1D",
        symbolIds: [],
      }).success,
    ).toBe(false);
  });

  it("offers the reference's seven correlation windows", () => {
    expect(CORRELATION_WINDOWS).toEqual(["5d", "10d", "30d", "60d", "90d", "180d", "250d"]);
    expect(
      correlationConfigSchema.safeParse({
        windows: ["30d", "90d"],
        defaultWindow: "30d",
        instrumentIds: [],
      }).success,
    ).toBe(true);
  });

  it("refuses a risk basket whose weights sum to zero", () => {
    // ADR-088 #6 — refused at the contract, not at render.
    const zeroed = riskSentimentConfigSchema.safeParse({
      components: [{ instrumentId: "a", weight: 0, direction: "risk-on" }],
      lookbackDays: 60,
      riskOffBelow: 35,
      riskOnAbove: 65,
    });
    expect(zeroed.success).toBe(false);
  });

  it("refuses bands that cross", () => {
    const crossed = riskSentimentConfigSchema.safeParse({
      components: [{ instrumentId: "a", weight: 1, direction: "risk-on" }],
      lookbackDays: 60,
      riskOffBelow: 70,
      riskOnAbove: 30,
    });
    expect(crossed.success).toBe(false);
  });

  it("accepts a well-formed risk basket", () => {
    expect(
      riskSentimentConfigSchema.safeParse({
        components: [
          { instrumentId: "a", weight: 2, direction: "risk-on" },
          { instrumentId: "b", weight: 1, direction: "risk-off" },
        ],
        lookbackDays: 60,
        riskOffBelow: 35,
        riskOnAbove: 65,
      }).success,
    ).toBe(true);
  });

  it("takes an HH:MM session time in its own zone and refuses anything else", () => {
    const base = { mediumVolumeFrom: 2, highVolumeFrom: 3 };
    expect(
      marketHoursConfigSchema.safeParse({
        ...base,
        sessions: [
          {
            name: "London",
            city: "London",
            timeZone: "Europe/London",
            open: "08:00",
            close: "17:00",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      marketHoursConfigSchema.safeParse({
        ...base,
        sessions: [
          {
            name: "London",
            city: "London",
            timeZone: "Europe/London",
            open: "8am",
            close: "17:00",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("carries the four rate-type markups the converter estimates from", () => {
    const ok = currencyConverterConfigSchema.safeParse({
      currencyIds: [],
      defaultFrom: "USD",
      defaultTo: "EUR",
      defaultAmount: 100,
      decimals: 2,
      rateMarkups: { bank: 3, atm: 4, card: 2.5, kiosk: 7 },
      offeredRateTypes: ["market", "bank"],
    });
    expect(ok.success).toBe(true);
  });

  it("reports a config that does not match its key, without throwing", () => {
    const result = parseToolConfig("gain-loss", { nope: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("parses a config that does match", () => {
    const result = parseToolConfig("gain-loss", { defaultStartBalance: 1000, decimals: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.decimals).toBe(2);
  });
});

describe("saveToolSchema", () => {
  const valid = {
    key: "gain-loss",
    isEnabled: true,
    sortOrder: 3,
    coverAssetId: null,
    relatedCount: 6,
    showRelated: true,
    config: { defaultStartBalance: 1000, decimals: 2 },
    translation: { locale: "en", title: "Gain & loss" },
    related: [{ targetType: "lesson", targetId: "abc" }],
  };

  it("accepts a well-formed save", () => {
    expect(saveToolSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a key that is not a registered tool", () => {
    expect(saveToolSchema.safeParse({ ...valid, key: "live-rates" }).success).toBe(false);
  });

  it("refuses a related item of an unknown type", () => {
    expect(
      saveToolSchema.safeParse({
        ...valid,
        related: [{ targetType: "podcast", targetId: "abc" }],
      }).success,
    ).toBe(false);
  });
});

describe("changes-41 calculator configs (ADR-135)", () => {
  const margin = {
    defaultAccountCurrency: "USD",
    defaultPairId: null,
    defaultUnits: 100000,
    defaultBalance: 10000,
    leverageOptions: [50, 100, 200, 400, 500],
    defaultLeverage: 100,
    pairIds: [],
    accountCurrencyIds: [],
  };

  it("accepts the seeded margin config and refuses a default leverage it does not offer", () => {
    expect(marginConfigSchema.safeParse(margin).success).toBe(true);
    const off = marginConfigSchema.safeParse({ ...margin, defaultLeverage: 30 });
    expect(off.success).toBe(false);
    expect(off.error?.issues[0]?.path).toEqual(["defaultLeverage"]);
    expect(marginConfigSchema.safeParse({ ...margin, leverageOptions: [] }).success).toBe(false);
    expect(marginConfigSchema.safeParse({ ...margin, leverageOptions: [0] }).success).toBe(false);
  });

  it("refuses a profit/loss default below a micro lot", () => {
    const valid = {
      defaultAccountCurrency: "USD",
      defaultLots: 1,
      pairIds: [],
      accountCurrencyIds: [],
    };
    expect(profitLossConfigSchema.safeParse(valid).success).toBe(true);
    expect(profitLossConfigSchema.safeParse({ ...valid, defaultLots: 0.001 }).success).toBe(false);
  });

  it("refuses risk-level thresholds that are out of order", () => {
    const valid = {
      defaultAccountCurrency: "USD",
      defaultBalance: 10000,
      defaultRiskPercent: 2,
      minRiskPercent: 0.1,
      maxRiskPercent: 10,
      conservativeMaxPercent: 1,
      moderateMaxPercent: 2,
      minRecommendedRatio: 2,
      pairIds: [],
      accountCurrencyIds: [],
    };
    expect(riskRewardConfigSchema.safeParse(valid).success).toBe(true);
    const swapped = riskRewardConfigSchema.safeParse({
      ...valid,
      conservativeMaxPercent: 3,
    });
    expect(swapped.success).toBe(false);
    expect(swapped.error?.issues[0]?.path).toEqual(["conservativeMaxPercent"]);
  });
});
