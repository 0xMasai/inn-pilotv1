/**
 * Did the guest just say "yes, book it"? (DECISIONS D27)
 *
 * The concierge may only create a reservation when the guest's own latest
 * message is an explicit confirmation of a summary they were already shown.
 * The model is told this in its instructions; this function is what makes it
 * true regardless of what the model decides.
 *
 * Deliberately conservative: an unclear message is not a confirmation, and
 * any negation ("don't book", "not yet", "wait") wins over an affirmative
 * word in the same message. A guest who gets asked once more loses a few
 * seconds; a guest booked without agreeing loses trust in the hotel.
 *
 * English only, like lead scoring (D20). Pure, shared by server and tests.
 */

const NEGATIONS = [
  /\bno\b/,
  /\bnope\b/,
  /\bnot\b/,
  /\bdon'?t\b/,
  /\bdo not\b/,
  /\bwait\b/,
  /\bhold on\b/,
  /\bcancel\b/,
  /\bstop\b/,
  /\bchange\b/,
  /\bactually\b/,
  /\binstead\b/,
  /\bnever ?mind\b/,
  /\?\s*$/,
];

const AFFIRMATIONS = [
  /\byes\b/,
  /\byeah\b/,
  /\byep\b/,
  /\byup\b/,
  /\bsure\b/,
  /\bok(ay)?\b/,
  /\bconfirm(ed)?\b/,
  /\bgo ahead\b/,
  /\bproceed\b/,
  /\bbook it\b/,
  /\bplease book\b/,
  /\bbook (the|this|that) (room|one|booking|stay)\b/,
  /\bthat'?s (correct|right|fine|perfect)\b/,
  /\ball (correct|good)\b/,
  /\blooks (good|right|correct|fine)\b/,
  /\bdo it\b/,
  /\bdeal\b/,
];

export function isExplicitConfirmation(message: string): boolean {
  const text = message.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  if (!text || text.length > 300) return false;
  if (NEGATIONS.some((pattern) => pattern.test(text))) return false;
  return AFFIRMATIONS.some((pattern) => pattern.test(text));
}

/** What the page's Confirm button sends: unmistakably a confirmation. */
export const CONFIRM_BOOKING_MESSAGE = "Yes, confirm this booking.";
