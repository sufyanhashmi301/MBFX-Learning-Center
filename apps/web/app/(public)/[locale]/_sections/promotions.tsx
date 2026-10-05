// The home band of live promotions (ADR-167, changes-52 §7.4).
//
// **Why it suspends on its own.** `getLivePromotions` has a lifetime under
// five minutes, because a promotion starts and ends by the clock, not by an
// admin action. Next leaves a cache that short out of the prerender and fills
// it per request (cacheLife docs, "Prerendering behavior"), so this band is a
// dynamic hole in an otherwise prerendered home page: the page keeps its own
// long lifetime, and only this band reads the clock. A hole needs its own
// `<Suspense>`, and the band sits high on the page — inside the eager bands
// the home page renders without a boundary — so the boundary lives HERE.
//
// **Why it waits for a request.** The band used to leave that decision to
// Next: the prerender's warming pass filled the short-lived entry, the final
// pass then excluded it, and every ISR regeneration of the home page logged
// "Unexpected cache miss after cache warming phase" (changes-62 #4) — a
// database read per regeneration whose result was thrown away. `connection()`
// says up front that this band is request-time, so the prerender skips it.
//
// The fallback is nothing, not a skeleton: most of the time no promotion is
// live, and a placeholder stripe that then vanishes reads as a bug.
import { connection } from "next/server";
import { Suspense } from "react";
import { HOME_BAND_PLACEMENTS } from "@repo/contracts";
import { getLivePromotions } from "@repo/core";
import { unavailablePromotionTargets } from "../../../_lib/promotion-flags.ts";
import { PromotionsBandCards } from "../_components/promotions-band-cards.tsx";
import type { SectionProps } from "./registry.ts";

async function PromotionsBandData({ locale }: { locale: string }) {
  await connection();
  const live = await getLivePromotions(locale, await unavailablePromotionTargets());
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
