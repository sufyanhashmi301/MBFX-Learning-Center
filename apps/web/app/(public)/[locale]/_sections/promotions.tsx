// The home band of live promotions (ADR-167, changes-52 §7.4).
//
// **Why it is prerendered (ADR-187, changes-65).** The band used to be the
// home page's one dynamic hole: `connection()` plus a cache under five
// minutes. A single hole makes the whole `/` response `private, no-store`, so
// no edge could cache the most visited page, and every visit paid the full
// trip to the origin. It now reads `getLivePromotionsForBand`, whose
// five-minute `expire` keeps it in the prerender: the page revalidates every
// 60 seconds, and a promotion starts or ends up to about a minute late. An
// admin save still shows at once (the `content` tag).
//
// The `<Suspense>` stays: it costs nothing when the data is prerendered, and
// it keeps a slow regeneration of this band from holding the bands above it.
//
// The fallback is nothing, not a skeleton: most of the time no promotion is
// live, and a placeholder stripe that then vanishes reads as a bug.
import { Suspense } from "react";
import { HOME_BAND_PLACEMENTS } from "@repo/contracts";
import { getLivePromotionsForBand } from "@repo/core";
import { unavailablePromotionTargets } from "../../../_lib/promotion-flags.ts";
import { PromotionsBandCards } from "../_components/promotions-band-cards.tsx";
import type { SectionProps } from "./registry.ts";

async function PromotionsBandData({ locale }: { locale: string }) {
  const live = await getLivePromotionsForBand(locale, await unavailablePromotionTargets());
  const inBand = live.filter(
    (p) =>
      p.showInBand &&
      p.placements.some((placement) =>
        (HOME_BAND_PLACEMENTS as readonly string[]).includes(placement),
      ),
  );
  if (inBand.length === 0) return null;
  return <PromotionsBandCards promotions={inBand} />;
}

export function Promotions({ locale }: SectionProps) {
  return (
    <Suspense fallback={null}>
      <PromotionsBandData locale={locale} />
    </Suspense>
  );
}
