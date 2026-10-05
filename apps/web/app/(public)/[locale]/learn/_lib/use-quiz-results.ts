"use client";

// The quiz index's learner island (design pass 2026-09-09).
//
// `useLearnerDashboard`'s sibling, and the same shape for the same reason: the
// quiz index is a cached, session-free page (ADR-056 #1), so the only way to
// know how a reader has done is to ask after paint. Everything the cards need
// to RENDER is already in the page payload; this adds three numbers per quiz
// and nothing else.
//
// A hook rather than a provider because there is exactly one consumer tree —
// the shelf — and a context would buy indirection with no second reader. It
// lives beside `quiz-labels.ts` rather than in `progress-provider.tsx`
// because that file is scoped to a COURSE's progress and this asks a question
// about every quiz; merging them would make every lesson page fetch a quiz
// history it never renders.
import { useEffect, useState } from "react";

import type { QuizProgressSummary, QuizProgressView } from "@repo/contracts";

import { usePublicSession } from "../../_components/public-session.tsx";

/**
 * The same five-state union `ProgressStatus` uses, and the states mean the
 * same things — `guest` is a 401, `off` is a flag the reader cannot see
 * through, `error` claims nothing. The shelf renders the pass-mark meter in
 * every state but `ready`, so none of them is a failure the reader has to see.
 */
export type QuizResultsStatus = "loading" | "guest" | "off" | "ready" | "error";

const ENDPOINT = "/api/learn/quiz/results";

export function useQuizResults(): {
  status: QuizResultsStatus;
  /** Quiz id → best result. Empty until `ready`, and empty on `ready` for a
   * learner who has never finished one. */
  byQuizId: Map<string, QuizProgressSummary>;
} {
  const [status, setStatus] = useState<QuizResultsStatus>("loading");
  const [byQuizId, setByQuizId] = useState<Map<string, QuizProgressSummary>>(() => new Map());

  // changes-65: ask only for a signed-in learner, once the session is known.
  // A guest's request could only answer 401, which the browser logs as a
  // console error for every signed-out visitor. The shelf draws the same
  // pass-mark meter for `guest` and `off`, so a guest loses nothing.
  const session = usePublicSession();
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
        const body = (await response.json()) as QuizProgressView;
        setByQuizId(new Map(body.results.map((row) => [row.quizId, row])));
        setStatus("ready");
      } catch {
        // An aborted fetch is a navigation, not a failure — leaving the status
        // at `loading` on an unmounting tree avoids a flash of anything.
        if (!controller.signal.aborted) setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [settled, signedIn]);

  if (settled && !signedIn) return { status: "guest", byQuizId };
  return { status, byQuizId };
}
