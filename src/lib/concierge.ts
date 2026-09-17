/**
 * The AI Concierge's browser side: talking to /api/ai/*, remembering a
 * conversation, and turning a reply into something readable.
 *
 * The page never touches Firestore. Everything it shows comes from the server
 * endpoints, which never return a workspace hotelId (DECISIONS D14). Types are
 * shared with the server so the two can't drift.
 *
 * A conversation belongs to a scope: the network concierge at `/#/`, or one
 * hotel's own link at `/#/c/:publicHotelId` (D25). Each scope keeps its own
 * chat in this tab.
 */
import type {
  AiMessage,
  ConciergeAvailability,
  ConciergeBooking,
  ConciergeHotel,
  ConciergeNetwork,
  ConciergeOption,
  ConciergeQuote,
  ConciergeReply,
  ConciergeSearch,
  NetworkHotel,
} from "../../server/ai/types";

export type {
  ConciergeAvailability,
  ConciergeBooking,
  ConciergeHotel,
  ConciergeNetwork,
  ConciergeOption,
  ConciergeQuote,
  ConciergeSearch,
  NetworkHotel,
};

/** Mirrors the gateway's own cap: older turns are dropped there anyway. */
export const HISTORY_TURNS_SENT = 12;
export const MAX_MESSAGE_CHARS = 2_000;

const NETWORK_ERROR =
  "I can't reach the concierge right now. Check your connection and try again in a moment.";

/** A failure the guest can read. `retryable` is false when trying again won't help. */
export class ConciergeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** Set when the server still recorded the guest's message. */
  readonly conversationId?: string;
  /** A booking that was made even though the reply failed. It is real: show it. */
  readonly booking?: ConciergeBooking;
  constructor(message: string, code: string, conversationId?: string, booking?: ConciergeBooking) {
    super(message);
    this.name = "ConciergeError";
    this.code = code;
    this.retryable = code !== "invalid_request";
    this.conversationId = conversationId;
    this.booking = booking;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new ConciergeError(NETWORK_ERROR, "network");
  }
  const body = await readJson(response);
  if (!response.ok || !body) {
    // The server's `error` is written for guests; anything else gets the generic line.
    const message = typeof body?.error === "string" ? body.error : NETWORK_ERROR;
    throw new ConciergeError(
      message,
      typeof body?.code === "string" ? body.code : `http_${response.status}`,
      typeof body?.conversationId === "string" ? body.conversationId : undefined,
      body?.booking && typeof body.booking === "object" ? (body.booking as ConciergeBooking) : undefined
    );
  }
  return body as T;
}

/** The participating hotels, for the home page. */
export function fetchNetwork(signal?: AbortSignal): Promise<ConciergeNetwork> {
  return call<ConciergeNetwork>("/api/ai/network", { signal });
}

/** One hotel's public header, for its own concierge link. */
export function fetchConciergeHotel(publicHotelId: string, signal?: AbortSignal): Promise<ConciergeHotel> {
  return call<ConciergeHotel>(`/api/ai/hotel?publicHotelId=${encodeURIComponent(publicHotelId)}`, { signal });
}

export interface SendOptions {
  /** A hotel's own link: the conversation reaches that hotel only. */
  publicHotelId?: string;
  conversationId?: string;
  /** The chat entry's id: a retry sends the same one, so the message is recorded once. */
  turnId?: string;
}

export function sendConciergeMessage(message: string, history: AiMessage[], options: SendOptions = {}): Promise<ConciergeReply> {
  return call<ConciergeReply>("/api/ai/concierge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message.slice(0, MAX_MESSAGE_CHARS),
      history: history.slice(-HISTORY_TURNS_SENT),
      ...(options.publicHotelId ? { publicHotelId: options.publicHotelId } : {}),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.turnId ? { turnId: options.turnId } : {}),
    }),
  });
}

export interface ThreadUpdate {
  handledBy: "ai" | "human";
  /** Staff replies; `at` is the server's clock, in milliseconds. */
  messages: { id: string; role: "guest" | "ai" | "staff"; text: string; at: number }[];
}

/** Staff replies in the guest's thread newer than `after` (server time). */
export function fetchThreadUpdates(conversationId: string, after: number, publicHotelId?: string): Promise<ThreadUpdate> {
  const params = new URLSearchParams({ conversationId, after: String(after) });
  if (publicHotelId) params.set("publicHotelId", publicHotelId);
  return call<ThreadUpdate>(`/api/ai/conversation?${params}`);
}

/**
 * Staff replies the page hasn't shown yet, as chat entries, plus the newest
 * server time seen. Deduplicated by message id, so polling twice over the
 * same window never shows a reply twice.
 */
export function newStaffEntries(update: ThreadUpdate, shown: ChatEntry[], after: number): { entries: ChatEntry[]; after: number } {
  const seen = new Set(shown.map((entry) => entry.id));
  const entries = update.messages
    .filter((m) => m.role === "staff" && !seen.has(m.id))
    .map((m): ChatEntry => ({ id: m.id, role: "assistant", text: m.text, from: "staff" }));
  const newest = update.messages.reduce((max, m) => Math.max(max, m.at), after);
  return { entries, after: newest };
}

/* ------------------------------------------------------------------ */
/* The conversation                                                     */
/* ------------------------------------------------------------------ */

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  search?: ConciergeSearch;
  availability?: ConciergeAvailability;
  quote?: ConciergeQuote;
  booking?: ConciergeBooking;
  /** A guest message that never got an answer. Shown, but not sent as history. */
  failed?: boolean;
  /** An assistant-side message written by hotel staff rather than the AI. */
  from?: "staff";
}

/** What the model sees as history: answered text turns only, no cards. */
export function historyOf(entries: ChatEntry[]): AiMessage[] {
  return entries.filter((entry) => !entry.failed).map(({ role, text }) => ({ role, content: text }));
}

const scopeOf = (publicHotelId?: string) => publicHotelId || "network";
const storageKey = (publicHotelId?: string) => `innpilot_concierge:${scopeOf(publicHotelId)}`;
const threadKey = (publicHotelId?: string) => `innpilot_concierge_thread:${scopeOf(publicHotelId)}`;

/** A reload keeps the chat for this tab; a new tab starts fresh. */
export function loadConversation(publicHotelId?: string): ChatEntry[] {
  try {
    const raw = sessionStorage.getItem(storageKey(publicHotelId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is ChatEntry =>
            !!entry &&
            (entry.role === "user" || entry.role === "assistant") &&
            typeof entry.text === "string" &&
            typeof entry.id === "string"
        )
      : [];
  } catch {
    return [];
  }
}

export function saveConversation(publicHotelId: string | undefined, entries: ChatEntry[]): void {
  try {
    sessionStorage.setItem(storageKey(publicHotelId), JSON.stringify(entries.slice(-40)));
  } catch {
    // Storage full or blocked: the chat still works, it just won't survive a reload.
  }
}

export function clearConversation(publicHotelId?: string): void {
  try {
    sessionStorage.removeItem(storageKey(publicHotelId));
    sessionStorage.removeItem(threadKey(publicHotelId));
  } catch {
    // Nothing to clear.
  }
}

/** The guest's thread on the server, and who was last handling it. */
export interface ThreadState {
  conversationId: string;
  handledBy: "ai" | "human";
  /** Newest server timestamp already shown, for polling. */
  after: number;
}

export function loadThread(publicHotelId?: string): ThreadState | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(threadKey(publicHotelId)) ?? "null") as ThreadState | null;
    return parsed && typeof parsed.conversationId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveThread(publicHotelId: string | undefined, thread: ThreadState | null): void {
  try {
    if (thread) sessionStorage.setItem(threadKey(publicHotelId), JSON.stringify(thread));
    else sessionStorage.removeItem(threadKey(publicHotelId));
  } catch {
    // Storage blocked: the thread just won't survive a reload.
  }
}

/* ------------------------------------------------------------------ */
/* Reply text                                                           */
/* ------------------------------------------------------------------ */

/** A run of text, bold or not. */
export interface Span {
  text: string;
  bold: boolean;
}

export type ReplyBlock = { kind: "paragraph"; spans: Span[] } | { kind: "list"; items: Span[][] };

/** "**Suite** from UGX 420,000" → [{Suite, bold}, {" from UGX 420,000"}]. */
export function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > last) spans.push({ text: line.slice(last, match.index), bold: false });
    spans.push({ text: match[1], bold: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last), bold: false });
  return spans.map((span) => ({ ...span, text: span.text.replace(/\*\*/g, "") }));
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * The model writes plain text with the occasional markdown bullet or bold.
 * This renders just those — never HTML — so nothing a reply contains can
 * become markup.
 */
export function parseReply(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blocks.push({ kind: "paragraph", spans: [] });
      continue;
    }
    if (BULLET.test(line)) {
      const item = parseSpans(line.replace(BULLET, ""));
      const previous = blocks.at(-1);
      if (previous?.kind === "list") previous.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
      continue;
    }
    const spans = parseSpans(line.replace(/^#{1,6}\s+/, ""));
    const previous = blocks.at(-1);
    if (previous?.kind === "paragraph" && previous.spans.length) {
      previous.spans.push({ text: " ", bold: false }, ...spans);
    } else {
      blocks.push({ kind: "paragraph", spans });
    }
  }
  return blocks.filter((block) => block.kind === "list" || block.spans.length);
}

/* ------------------------------------------------------------------ */
/* Dates and the messages buttons send                                  */
/* ------------------------------------------------------------------ */

/** "2031-06-01" → "Sun, 1 Jun 2031", read as a calendar day (no timezone shift). */
export function stayDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "10 Oct – 15 Oct 2031", compact, for a card header. */
export function stayRange(checkIn: string, checkOut: string): string {
  const format = (iso: string, withYear: boolean) => {
    const [year, month, day] = iso.split("-").map(Number);
    if (!year || !month || !day) return iso;
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  };
  return `${format(checkIn, false)} – ${format(checkOut, true)}`;
}

/** What "Choose this room" on a search result sends, in the guest's voice. */
export function chooseOptionMessage(option: Pick<ConciergeOption, "optionNumber" | "roomType" | "hotelName">): string {
  return `I'll take option ${option.optionNumber}: the ${option.roomType} at ${option.hotelName}.`;
}

/** What choosing a room type on one hotel's availability card sends. */
export function chooseRoomTypeMessage(roomType: string, hotelName: string): string {
  return `I'll take the ${roomType} at ${hotelName}.`;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                         */
/* ------------------------------------------------------------------ */

/** A calm, distinct header colour per hotel, standing in for photography the data doesn't have. */
const HEADER_TONES = [
  ["#0e93a3", "#2dd4c8"],
  ["#0b1220", "#0e93a3"],
  ["#155e75", "#22d3ee"],
  ["#134e4a", "#14b8a6"],
  ["#1e3a8a", "#38bdf8"],
];

export function toneFor(key: string): [string, string] {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return HEADER_TONES[hash % HEADER_TONES.length] as [string, string];
}
