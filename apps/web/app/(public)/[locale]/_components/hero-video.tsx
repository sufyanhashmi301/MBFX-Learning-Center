"use client";

// The opening slide's background footage (changes-31).
//
// A client island for one reason: whether it plays at all is the visitor's
// decision, and `prefers-reduced-motion` cannot be read on the server. Looping
// footage under a headline is exactly the "large-scale motion" the reduced-
// motion preference is about, and the global `animation-duration: 0.01ms`
// reset in globals.css does nothing to a <video> — it is not an animation.
//
// **There is deliberately no `autoPlay` attribute.** With one, the browser
// starts the footage from the server HTML, before this component has hydrated
// and before anyone has asked whether motion is wanted — a reduced-motion
// visitor would see it play and then stop. Instead the element renders paused
// paused, and playback is started here, after hydration, only when motion is
// allowed.
//
// **There is no `poster` either, since changes-33.** There was one, and it
// was `/hero-app-mockup.jpg` — a picture of the app, not a still from the
// footage. So the slide painted a photograph, held it, and then replaced it
// with something else entirely the moment playback started. A swap between
// two unrelated images reads as a bug, and it is the one the owner reported.
//
// Extracting a real still would have been the other fix and is still the
// better one; nothing in this toolchain can decode the H.264 to do it (the
// only ffmpeg on hand is Playwright's, built webm-only). So the slot is empty
// and the band behind the video carries a solid `--secondary` fill instead:
// the same token the scrim over it fades from, so the hero is a coherent dark
// panel from first paint and the footage arrives INTO it rather than
// replacing something.
//
// With JS off the slide is that panel with its copy on it, which is a
// complete and honest state rather than a broken one. And the 8.8 MB of
// footage is still never on the critical path — `preload="none"` and a play()
// that waits until the video nears the viewport are what guarantee that, not
// the poster.
//
// **It loads when it is about to be SEEN (changes-62 #2).** The one call site
// left is the "In practice" band, far below the fold, and an unconditional
// play() after hydration fetched its whole clip (940 KB) on every home page
// view, competing with the page's own scripts. Now `preload="none"` fetches
// nothing up front, an IntersectionObserver starts playback as the band
// approaches the viewport, and the clip pauses again once it has left it.
//
// Decorative: the footage carries no information the copy beside it does not,
// and it has no audio track to caption. `aria-hidden` keeps it out of the
// accessibility tree entirely, which is why there are no controls either —
// a control a screen reader cannot reach is worse than no control.
import { useEffect, useRef } from "react";

import { cn } from "@repo/ui/lib/utils";

function HeroVideo({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          // `play()` rejects rather than throws when a browser refuses
          // autoplay — a data-saver mode, a battery-saver mode, or a policy
          // this page cannot see. That is a legitimate outcome, not an error:
          // the band stays on its still, and an unhandled rejection in the
          // console would be the only damage.
          void el.play().catch(() => {});
        } else {
          el.pause();
        }
      },
      // Start a little before it scrolls in, so the first frames are there
      // when it arrives.
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      // No `autoPlay` and no `poster` — see the header. The rest are what let
      // a browser play it inline at all: muted and playsInline are both
      // required on iOS, and muted is required by every desktop autoplay
      // policy.
      muted
      loop
      playsInline
      preload="none"
      aria-hidden
      tabIndex={-1}
      className={cn("size-full object-cover", className)}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}

export { HeroVideo };
