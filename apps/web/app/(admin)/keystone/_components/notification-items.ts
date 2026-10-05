// Notification rows → the bell's display items (ADR-014). Shared by the
// shell's first render and the bell's own refresh endpoint, so the two can
// never word the same row differently. Text renders on the SERVER: the type
// is a catalog key and the detail is data interpolated into it.
import { countUnreadNotifications, listNotifications } from "@repo/core";
import { getTranslations } from "next-intl/server";
import type { NotificationFeed } from "./notification-bell.tsx";

export type { NotificationFeed };

export async function loadNotificationFeed(userId: string): Promise<NotificationFeed> {
  const [t, unreadCount, rows] = await Promise.all([
    getTranslations("admin"),
    countUnreadNotifications(userId),
    listNotifications(userId),
  ]);
  return {
    unreadCount,
    items: rows.map((n) => ({
      id: n.id,
      text: t.has(`notifications.${n.type}`)
        ? t(`notifications.${n.type}`, { detail: n.detail })
        : n.type,
      href: n.href,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}
