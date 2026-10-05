// Navigation contracts (Module 08). The exactly-one-of url/routeKey rule
// lives here (plan.md: "resolves routeKey vs external url — exactly-one
// rule validated by contracts") so both the admin's menu editor (Module
// 09) and @repo/core's builder validate against the same schema.
//
// The route registry itself lives in routes.ts, which has no Zod import, so a
// client component can read ROUTE_PATHS without loading Zod (changes-62 #2).
import { z } from "zod";
import { isRouteKey } from "./routes.ts";

export const menuItemLinkSchema = z
  .object({
    url: z.string().max(500).nullish(),
    routeKey: z.string().max(100).nullish(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.routeKey), {
    message: "Exactly one of url or routeKey must be set",
  })
  .refine((v) => !v.routeKey || isRouteKey(v.routeKey), {
    message: "routeKey must exist in the ROUTE_PATHS registry",
  });

export type MenuItemLink = z.infer<typeof menuItemLinkSchema>;
