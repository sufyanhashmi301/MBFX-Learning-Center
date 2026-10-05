"use client";

// Topbar notification bell (changes-01 / ADR-014). Items arrive already
// translated (type → catalog string with the detail interpolated); this
// component only renders, marks read, and navigates.
//
// The shell renders the first feed, but the shell is the admin LAYOUT, which
// a client navigation does not re-render (changes-65): the bell used to show
// that first count until a hard reload. It now re-reads its own feed from
// `/keystone/api/notifications` after every navigation and whenever it is
// opened — never on a timer, because a request is session activity and an
// idle tab must stay idle (ADR-105).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Bell } from "lucide-react";
import { CountBadge } from "@repo/ui/components/count-badge";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { EmptyState } from "@repo/ui/components/empty";
import { cn } from "@repo/ui/lib/utils";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "../_actions/notification-actions.ts";

export interface NotificationItem {
  id: string;
  text: string;
  href: string | null;
  read: boolean;
  createdAt: string; // ISO — formatted client-side
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((then - Date.now()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

export interface NotificationFeed {
  items: NotificationItem[];
  unreadCount: number;
}

const FEED_URL = "/keystone/api/notifications";

export function NotificationBell({
  initialFeed,
  labels,
}: {
  initialFeed: NotificationFeed;
  labels: { title: string; empty: string; markAllRead: string; openMenu: string };
}) {
  const pathname = usePathname();
  const [feed, setFeed] = useState(initialFeed);
  const [, startTransition] = useTransition();
  const inFlight = useRef<AbortController | null>(null);
  const { items, unreadCount } = feed;

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const response = await fetch(FEED_URL, { cache: "no-store", signal: controller.signal });
      // A 401 is a session that just ended; the idle watcher handles that.
      if (response.ok) setFeed((await response.json()) as NotificationFeed);
    } catch {
      // Aborted or offline: keep what is shown. The next navigation retries.
    }
  }, []);

  // The first render already holds the shell's feed, so skip the first path.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const markRead = (id: string) => {
    // Optimistic: the row reads as read at once, the server confirms after.
    setFeed((current) => {
      const target = current.items.find((item) => item.id === id);
      if (!target || target.read) return current;
      return {
        unreadCount: Math.max(0, current.unreadCount - 1),
        items: current.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
      };
    });
    startTransition(async () => {
      await markNotificationReadAction(id);
      await refresh();
    });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refresh();
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={labels.openMenu} className="relative">
            <Bell className="size-5" />
            {/* Hides itself at zero; the reference caps the bell at 999+. */}
            <CountBadge count={unreadCount} max={999} placement="corner" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80">
        {/* Plain heading, not DropdownMenuLabel — Base UI's GroupLabel
            demands a Menu.Group ancestor, and this header row isn't one. */}
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
          <span className="text-sm font-medium">{labels.title}</span>
          {unreadCount > 0 && (
            <Button
              variant="link"
              size="xs"
              onClick={() =>
                startTransition(async () => {
                  setFeed((current) => ({
                    unreadCount: 0,
                    items: current.items.map((item) => ({ ...item, read: true })),
                  }));
                  await markAllNotificationsReadAction();
                  await refresh();
                })
              }
            >
              {labels.markAllRead}
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          // Borderless: the menu is already the container.
          <EmptyState size="sm" title={labels.empty} className="border-none" />
        ) : (
          <DropdownMenuGroup className="max-h-80 overflow-y-auto">
            {items.map((item) => {
              const body = (
                <span className="flex w-full flex-col items-start gap-0.5 py-0.5">
                  <span className={cn("text-sm", !item.read && "font-medium")}>
                    {!item.read && (
                      <span
                        aria-hidden
                        className="mb-0.5 me-1.5 inline-block size-1.5 rounded-full bg-primary"
                      />
                    )}
                    {item.text}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(item.createdAt)}
                  </span>
                </span>
              );
              return item.href ? (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => markRead(item.id)}
                  render={<Link href={item.href}>{body}</Link>}
                />
              ) : (
                <DropdownMenuItem key={item.id} onClick={() => markRead(item.id)}>
                  {body}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
