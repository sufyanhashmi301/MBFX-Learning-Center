"use client";

// The progress island's brain (changes-11 PR 5.3, ADR-056 #1).
//
// **Why a provider rather than one component.** A course page needs the same
// progress in three places that are nowhere near each other in the tree — the
// bar in the header card, the CTA beside it, and the marker on every lesson
// row further down. Three islands would mean three fetches of the same thing
// on one paint. One provider fetches once and the consumers are cheap.
//
// **Why the children stay server-rendered.** `children` is passed THROUGH this
// client component, so everything inside it (the hero, the prose, the
// recommendations) is still rendered on the server and streamed as RSC
// payload. Only the leaves that call `useProgress()` are client components.
//
// **Why there is no optimistic state.** Every write returns the recomputed
// `CourseProgressView` from the server, and that value replaces local state
// wholesale. An optimistic ✓ that a failed request has to walk back is a worse
// experience than a control that is briefly busy, and it would let the
// denormalised counter and the screen disagree.
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CourseProgressView,
  EnrollmentSummary,
  LearnerDashboardView,
  LessonProgressState,
} from "@repo/contracts";

import { usePublicSession } from "../../_components/public-session.tsx";

/**
 * - `loading` — the fetch is in flight; render the not-started state.
 * - `guest`   — 401. The reader may read everything and save nothing
 *               (ADR-056 #3); this is what shows the sign-in card.
 * - `off`     — 404. `courses` or `progress_tracking` is not visible to this
 *               reader, so progress does not exist here. Distinct from `guest`
 *               because inviting someone to sign in for a feature that is
 *               switched off is a broken promise.
 * - `ready`   — real state, in `view`.
 * - `error`   — the request failed. The page still works; nothing is claimed.
 */
export type ProgressStatus = "loading" | "guest" | "off" | "ready" | "error";

export type ProgressAction = "complete" | "incomplete" | "touch";

interface ProgressContextValue {
  status: ProgressStatus;
  view: CourseProgressView | null;
  /** Per-lesson state, or undefined for a lesson with no row (= not started). */
  stateFor: (lessonId: string) => LessonProgressState | undefined;
  /** True while a write is in flight, so a control can disable itself. */
  pending: boolean;
  write: (action: ProgressAction, lessonId: string) => Promise<void>;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

const ENDPOINT = "/api/learn/progress";

/**
 * `null` outside a provider rather than a throw.
 *
 * A consumer rendered outside one should degrade to the not-started state the
 * server already rendered, not crash the page. The progress island is an
 * enhancement; nothing on these pages is allowed to depend on it existing.
 */
export function useProgress(): ProgressContextValue {
  return (
    use(ProgressContext) ?? {
      status: "off",
      view: null,
      stateFor: () => undefined,
      pending: false,
      write: async () => {},
    }
  );
}

export function ProgressProvider({
  courseId,
  /**
   * Recorded as visited as soon as the provider mounts, when given — the
   * lesson page passes the lesson being read. This is what moves "Continue
   * learning" forward without the reader pressing anything.
   */
  touchLessonId,
  children,
}: {
  courseId: string;
  touchLessonId?: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<ProgressStatus>("loading");
  const [view, setView] = useState<CourseProgressView | null>(null);
  const [pending, setPending] = useState(false);

  /** Applies one response to state, mapping the status codes to the union. */
  const apply = useCallback(async (response: Response): Promise<void> => {
    if (response.status === 401) {
      setStatus("guest");
      return;
    }
    if (response.status === 404) {
      setStatus("off");
      return;
    }
    if (!response.ok) {
      setStatus("error");
      return;
    }
    setView((await response.json()) as CourseProgressView);
    setStatus("ready");
  }, []);

  // The provider is mounted once per page view and the effect runs once. React
  // 19 Strict Mode double-invokes effects in development, which would fire two
  // touches; the ref makes that a no-op rather than two rows racing for the
  // same unique key.
  //
  // **There is deliberately no AbortController here (changes-39).** It used to
  // abort in the cleanup, and under Strict Mode that cleanup runs BETWEEN the
  // two invocations: the first run's request was aborted and the second run
  // returned early on the ref, so nothing was ever fetched. `status` sat at
  // `loading` for the life of the page — the "Mark this lesson complete"
  // button stayed disabled (muted) — and the touch that records the visit
  // never reached the server, so a signed-in reader's history stayed empty.
  // A touch is a write that should land even if the reader navigates away,
  // and a state update after unmount is a no-op in React 19, so there is
  // nothing for an abort to protect.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        // A touch is a write that ALSO returns the full view, so a lesson page
        // costs one request rather than a POST and then a GET.
        const response = touchLessonId
          ? await fetch(ENDPOINT, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lessonId: touchLessonId, action: "touch" }),
            })
          : await fetch(`${ENDPOINT}?course=${encodeURIComponent(courseId)}`);
        await apply(response);
      } catch {
        setStatus("error");
      }
    })();
  }, [courseId, touchLessonId, apply]);

  const write = useCallback(
    async (action: ProgressAction, lessonId: string) => {
      setPending(true);
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lessonId, action }),
        });
        await apply(response);
      } catch {
        setStatus("error");
      } finally {
        setPending(false);
      }
    },
    [apply],
  );

  // changes-50 (image-4): the public site shows a STAFF session as signed out
  // (ADR-094), so progress does too. The endpoint answers a staff session with
  // real progress, which hid the "Save your progress" card and the "Track your
  // progress" band from an admin browsing the site while the header beside
  // them said "Sign in". A signed-out reader is a guest wherever progress
  // exists; `off` is left alone, because the feature is off for everyone.
  const session = usePublicSession();
  const readsAsGuest = session.status === "anonymous" && (status === "ready" || status === "guest");
  const shownStatus: ProgressStatus = readsAsGuest ? "guest" : status;
  const shownView = readsAsGuest ? null : view;

  const value = useMemo<ProgressContextValue>(() => {
    const byLesson = new Map(shownView?.lessons.map((row) => [row.lessonId, row.state]) ?? []);
    return {
      status: shownStatus,
      view: shownView,
      stateFor: (lessonId: string) => byLesson.get(lessonId),
      pending,
      write,
    };
  }, [shownStatus, shownView, pending, write]);

  return <ProgressContext value={value}>{children}</ProgressContext>;
}

/**
 * The learner's enrollment summaries, for the `/learn` shelf's "Pick up where
 * you left off" band (PR 5.4).
 *
 * A hook rather than a second provider because it has exactly one consumer,
 * and it is deliberately NOT part of `ProgressProvider`: that provider is
 * scoped to one course and this answers a question about all of them. Merging
 * them would make every lesson page fetch a dashboard it never renders.
 *
 * The same three non-`ready` statuses mean the same things here, and the band
 * renders in none of them — an empty "your courses" band on a first visit is
 * chrome for content that does not exist.
 */
export function useLearnerDashboard(): {
  status: ProgressStatus;
  enrollments: EnrollmentSummary[];
} {
  const [status, setStatus] = useState<ProgressStatus>("loading");
  const [enrollments, setEnrollments] = useState<EnrollmentSummary[]>([]);
  const session = usePublicSession();

  // changes-65: wait for the session and ask only for a signed-in learner. A
  // guest's request could only ever answer 401, which every browser logs as
  // a console error on `/learn` for every signed-out visitor. The band
  // renders in no non-`ready` state, so a guest loses nothing by not asking
  // (unlike `ProgressProvider`, whose `guest`/`off` split needs the answer).
  const signedIn = session.status === "learner";
  const settled = session.status !== "loading";
  useEffect(() => {
    // A guest is answered below, at render: nothing to ask the server.
    if (!settled || !signedIn) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(ENDPOINT, { signal: controller.signal });
        if (response.status === 401) return setStatus("guest");
        if (response.status === 404) return setStatus("off");
        if (!response.ok) return setStatus("error");
        const body = (await response.json()) as LearnerDashboardView;
        setEnrollments(body.enrollments);
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [settled, signedIn]);

  // The same rule as `ProgressProvider`: a reader the public site shows as
  // signed out has no enrollments to pick up.
  if (settled && !signedIn) return { status: "guest", enrollments: [] };
  return { status, enrollments };
}
