// The page-wide signal that translation work was just queued (ADR-189 #6).
// Its own module so the Sync dialog and the progress panel that draws it can
// both import it without importing each other.
export const TRANSLATION_WORK_EVENT = "translation-work-started";

/** Tells every progress panel on the page that work was just queued. */
export function announceTranslationWork(): void {
  window.dispatchEvent(new Event(TRANSLATION_WORK_EVENT));
}
