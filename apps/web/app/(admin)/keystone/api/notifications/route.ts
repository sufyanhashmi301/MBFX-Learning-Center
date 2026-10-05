import { NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError } from "@repo/rbac";
import { requireStaffSubject } from "../../_actions/staff-subject.ts";
import { loadNotificationFeed } from "../../_components/notification-items.ts";

// The bell's refresh read (ADR-014, changes-65). The bell is drawn by the
// admin LAYOUT, and a layout is not re-rendered on a client navigation, so
// the count the shell rendered stayed frozen until a hard reload: a role
// assigned while you were in the portal never showed. The bell asks here
// after each navigation and when it is opened. Both are the reader's own
// actions, so an idle tab sends nothing. A timer would also keep sliding the
// session that ADR-105's idle timeout is meant to expire.
//
// Self-scoped like the actions: rows are read for the caller's own id only,
// so there is no permission key; the STAFF check is DB-verified.
export async function GET(): Promise<NextResponse> {
  let subjectId: string;
  try {
    subjectId = (await requireStaffSubject()).id;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw error;
  }
  return NextResponse.json(await loadNotificationFeed(subjectId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
