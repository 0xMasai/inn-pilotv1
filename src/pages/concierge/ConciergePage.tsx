/**
 * InnPilot AI Concierge — the public product.
 *
 *   /#/                     the network concierge: every participating K Hotels property
 *   /#/c/:publicHotelId     the same concierge on one hotel's own link
 *
 * A guest describes where and when they want to stay, sees real options from
 * live inventory, picks one, confirms a summary and gets a real booking
 * reference — without an account and without meeting the PMS behind it.
 *
 * The page talks only to /api/ai/* (src/lib/concierge.ts). It never reads
 * Firestore and never sees a workspace hotelId.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Building2,
  CalendarCheck,
  Headset,
  MapPin,
  MessageSquarePlus,
  MessagesSquare,
  SearchX,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

import innpilotMark from "../../assets/brand/innpilot-mark.png";
import {
  clearConversation,
  ConciergeError,
  fetchConciergeHotel,
  fetchNetwork,
  fetchThreadUpdates,
  historyOf,
  loadConversation,
  loadThread,
  MAX_MESSAGE_CHARS,
  newStaffEntries,
  saveConversation,
  saveThread,
  sendConciergeMessage,
  type ChatEntry,
  type ConciergeHotel,
  type NetworkHotel,
  toneFor,
  type ThreadState,
} from "../../lib/concierge";
import { money } from "../../lib/format";
import { isPublicHotelId } from "../../lib/publicHotel";
import { AssistantAvatar, ErrorNotice, MessageBubble, TypingIndicator, type EntryActions } from "./parts";

const newId = () => Math.random().toString(36).slice(2, 11);

/** How often the page checks for staff replies while staff handle the chat. */
const STAFF_POLL_MS = 5_000;
/** While the AI answers, check less often: only to notice staff stepping in. */
const AI_POLL_MS = 15_000;
/**
 * Each poll re-reads a little before the newest message already seen:
 * replies are deduplicated by id, and server and staff clocks can differ.
 */
const POLL_OVERLAP_MS = 30_000;

const NETWORK_SUGGESTIONS = [
  "Find me a room tonight",
  "Double room in Western Uganda this weekend",
  "Family room from 10–15 October",
  "Find the cheapest available room in Kabale",
];

const hotelSuggestions = (name: string) => [
  "Is a room free tonight?",
  "Double room this weekend",
  "Family room from 10–15 October",
  `Does ${name} include breakfast and parking?`,
];

export default function ConciergePage() {
  const { publicHotelId } = useParams();
  if (publicHotelId === undefined) return <Concierge />;
  return <HotelConcierge publicHotelId={publicHotelId} />;
}

/* ------------------------------------------------------------------ */
/* One hotel's own link                                                 */
/* ------------------------------------------------------------------ */

type HotelState =
  | { status: "loading" }
  | { status: "ready"; hotel: ConciergeHotel }
  | { status: "not-found" }
  | { status: "error"; message: string };

function HotelConcierge({ publicHotelId }: { publicHotelId: string }) {
  const [state, setState] = useState<HotelState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isPublicHotelId(publicHotelId)) {
      setState({ status: "not-found" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchConciergeHotel(publicHotelId, controller.signal)
      .then((hotel) => setState({ status: "ready", hotel }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Something went wrong.";
        setState(error instanceof ConciergeError && !error.retryable ? { status: "not-found" } : { status: "error", message });
      });
    return () => controller.abort();
  }, [publicHotelId, reloadKey]);

  if (state.status === "loading") return <LoadingScreen />;
  if (state.status === "not-found") return <NotFoundScreen />;
  if (state.status === "error") return <LoadErrorScreen message={state.message} onRetry={() => setReloadKey((k) => k + 1)} />;
  return <Concierge hotel={state.hotel} />;
}

/* ------------------------------------------------------------------ */
/* The concierge                                                        */
/* ------------------------------------------------------------------ */

function Concierge({ hotel }: { hotel?: ConciergeHotel }) {
  const publicHotelId = hotel?.publicHotelId;
  const [entries, setEntries] = useState<ChatEntry[]>(() => loadConversation(publicHotelId));
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; retryText?: string } | null>(null);
  const [thread, setThread] = useState<ThreadState | null>(() => loadThread(publicHotelId));
  const afterRef = useRef(thread?.after ?? 0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.title = hotel ? `${hotel.name} · InnPilot AI Concierge` : "InnPilot AI Concierge · Find your stay with AI";
  }, [hotel]);
  useEffect(() => saveConversation(publicHotelId, entries), [publicHotelId, entries]);
  useEffect(() => saveThread(publicHotelId, thread), [publicHotelId, thread]);

  const conversationId = thread?.conversationId;
  const staffHandling = thread?.handledBy === "human";

  // Staff replies: every few seconds while staff handle the chat, now and then
  // while the AI does, since staff can step in before the guest writes again.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const since = Math.max(0, afterRef.current - POLL_OVERLAP_MS);
        const update = await fetchThreadUpdates(conversationId, since, publicHotelId);
        if (cancelled) return;
        setEntries((current) => {
          const fresh = newStaffEntries(update, current, since).entries;
          return fresh.length ? [...current, ...fresh] : current;
        });
        afterRef.current = newStaffEntries(update, [], afterRef.current).after;
        setThread({ conversationId, handledBy: update.handledBy, after: afterRef.current });
      } catch (caught) {
        if (cancelled) return;
        // The thread is gone: the next message starts a new one.
        if (caught instanceof ConciergeError && !caught.retryable) {
          afterRef.current = 0;
          setThread(null);
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, staffHandling ? STAFF_POLL_MS : AI_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [publicHotelId, conversationId, staffHandling]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, pending, error]);

  /** One guest turn. `retrying` resends the last undelivered message instead of adding one. */
  const send = useCallback(
    async (text: string, retrying = false) => {
      const message = text.trim();
      if (!message || pending) return;

      let failedIndex = -1;
      if (retrying) {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].role === "user" && entries[i].failed) {
            failedIndex = i;
            break;
          }
        }
      }
      const userId = failedIndex >= 0 ? entries[failedIndex].id : newId();
      const history = failedIndex >= 0 ? entries.slice(0, failedIndex) : entries;
      setEntries(
        failedIndex >= 0
          ? entries.map((e, i) => (i === failedIndex ? { ...e, failed: false } : e))
          : [...entries, { id: userId, role: "user", text: message }]
      );
      setDraft("");
      setError(null);
      setPending(true);

      try {
        const reply = await sendConciergeMessage(message, historyOf(history), { publicHotelId, conversationId, turnId: userId });
        if (reply.conversationId) {
          setThread({ conversationId: reply.conversationId, handledBy: reply.handledBy ?? "ai", after: afterRef.current });
        }
        setEntries((current) => [
          ...current,
          {
            id: newId(),
            role: "assistant",
            text: reply.reply,
            ...(reply.search ? { search: reply.search } : {}),
            ...(reply.availability ? { availability: reply.availability } : {}),
            ...(reply.quote ? { quote: reply.quote } : {}),
            ...(reply.booking ? { booking: reply.booking } : {}),
          },
        ]);
      } catch (caught) {
        const failure =
          caught instanceof ConciergeError ? caught : new ConciergeError("Something went wrong sending that message. Please try again.", "unexpected");
        if (failure.conversationId) {
          const id = failure.conversationId;
          setThread((current) => ({ conversationId: id, handledBy: current?.handledBy ?? "ai", after: afterRef.current }));
        }
        if (failure.booking) {
          // The reservation exists even though the reply didn't arrive: never hide it.
          const booking = failure.booking;
          setEntries((current) => [...current, { id: newId(), role: "assistant", text: "Your booking is confirmed.", booking }]);
        } else {
          setEntries((current) => current.map((e) => (e.id === userId ? { ...e, failed: true } : e)));
          setError({ message: failure.message, ...(failure.retryable ? { retryText: message } : {}) });
        }
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [entries, pending, publicHotelId, conversationId]
  );

  const startOver = () => {
    clearConversation(publicHotelId);
    setEntries([]);
    setThread(null);
    afterRef.current = 0;
    setError(null);
    setDraft("");
  };

  const actions: EntryActions = {
    disabled: pending,
    onSend: (text) => void send(text),
    onEdit: () => {
      setDraft("I'd like to change ");
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  };

  const composer = (
    <Composer
      inputRef={inputRef}
      draft={draft}
      onDraft={setDraft}
      onSend={() => void send(draft)}
      pending={pending}
      large={entries.length === 0}
      placeholder={
        entries.length > 0
          ? "Reply to the concierge…"
          : hotel
            ? `Ask ${hotel.name} for a room…`
            : "I need a double room in Western Uganda from 10–15 October"
      }
    />
  );

  return (
    // The chat is a fixed-height view whose message list scrolls; the home page scrolls as a page.
    <div className={`${entries.length ? "h-[100dvh] overflow-hidden" : "min-h-[100dvh]"} flex flex-col`} style={{ background: "var(--app-bg)" }}>
      <TopBar hotel={hotel} onNewChat={entries.length > 0 ? startOver : undefined} disabled={pending} />

      {entries.length === 0 ? (
        <Home hotel={hotel} composer={composer} disabled={pending} onSend={(text) => void send(text)} />
      ) : (
        <main className="flex-1 flex flex-col w-full max-w-3xl mx-auto min-h-0">
          <div ref={listRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5" aria-live="polite">
            {entries.map((entry) => (
              <MessageBubble key={entry.id} entry={entry} actions={actions} />
            ))}
            {pending && <TypingIndicator />}
            {error && <ErrorNotice message={error.message} onRetry={error.retryText ? () => void send(error.retryText!, true) : undefined} />}
          </div>

          <div
            className="shrink-0 px-3 sm:px-6 pt-2 pb-3"
            style={{ background: "linear-gradient(to top, var(--app-bg) 75%, transparent)" }}
          >
            {staffHandling && (
              <p
                className="mb-2 rounded-xl px-3 py-2 text-xs flex items-center gap-2"
                style={{ background: "var(--warning-soft)", color: "var(--warning-text)", border: "1px solid var(--warning-border)" }}
                role="status"
              >
                <Headset size={14} /> A member of the hotel team is handling your chat. Their replies appear here.
              </p>
            )}
            {composer}
            <p className="text-[11px] muted mt-1.5 text-center">
              Rooms, prices and bookings come live from {hotel ? hotel.name : "K Hotels"}' booking systems.
            </p>
          </div>
        </main>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Frame                                                                */
/* ------------------------------------------------------------------ */

function TopBar({ hotel, onNewChat, disabled }: { hotel?: ConciergeHotel; onNewChat?: () => void; disabled: boolean }) {
  return (
    <header className="sticky top-0 z-30" style={{ background: "var(--brand-navy)", borderBottom: "1px solid var(--rail-border)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <Link to={hotel ? `/c/${hotel.publicHotelId}` : "/"} className="flex items-center gap-2.5 min-w-0" onClick={onNewChat}>
          <img src={innpilotMark} alt="" className="w-7 h-7 rounded-md" />
          <span className="font-poppins font-semibold text-white truncate">{hotel ? hotel.name : "InnPilot"}</span>
          <span
            className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5"
            style={{ background: "var(--rail-active)", color: "var(--brand-cyan)" }}
          >
            <Sparkles size={11} /> AI Concierge
          </span>
        </Link>
        <nav className="flex items-center gap-2 shrink-0">
          {onNewChat && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid var(--rail-border)" }}
              onClick={onNewChat}
              disabled={disabled}
            >
              <MessageSquarePlus size={15} /> <span className="hidden sm:inline">New search</span>
            </button>
          )}
          <Link to="/staff" className="text-xs sm:text-sm px-2 py-1.5 rounded-md" style={{ color: "var(--rail-text)" }}>
            For hotels
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Composer({
  inputRef,
  draft,
  onDraft,
  onSend,
  pending,
  large,
  placeholder,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  pending: boolean;
  large: boolean;
  placeholder: string;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };
  const maxHeight = large ? 160 : 144;

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-2xl p-2 pl-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: large ? "var(--shadow-lg)" : "var(--shadow-md)" }}
    >
      <label htmlFor="concierge-input" className="sr-only">
        Describe the stay you're looking for
      </label>
      <textarea
        id="concierge-input"
        ref={inputRef}
        className={`flex-1 resize-none bg-transparent outline-none leading-relaxed py-2 ${large ? "text-base sm:text-lg" : "text-[0.9375rem]"}`}
        style={{ color: "var(--text)", maxHeight }}
        rows={large ? 2 : 1}
        maxLength={MAX_MESSAGE_CHARS}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          onDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, maxHeight)}px`;
        }}
        onKeyDown={onKeyDown}
        disabled={pending}
        autoFocus={large}
      />
      <button
        type="submit"
        className={`btn btn-primary shrink-0 !p-0 rounded-xl ${large ? "h-12 w-12" : "h-10 w-10"}`}
        disabled={pending || !draft.trim()}
        aria-label="Send"
      >
        <ArrowUp size={large ? 22 : 18} />
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Home                                                                 */
/* ------------------------------------------------------------------ */

function Home({
  hotel,
  composer,
  disabled,
  onSend,
}: {
  hotel?: ConciergeHotel;
  composer: ReactNode;
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const suggestions = hotel ? hotelSuggestions(hotel.name) : NETWORK_SUGGESTIONS;
  return (
    <main className="flex-1">
      <section
        className="relative overflow-hidden"
        style={{
          background:
            "radial-gradient(1100px 480px at 15% -10%, rgba(45,212,200,0.22), transparent 60%), radial-gradient(900px 420px at 95% 10%, rgba(14,147,163,0.28), transparent 60%), var(--brand-navy)",
        }}
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-12 sm:pt-20 pb-12 sm:pb-16">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <p
              className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1"
              style={{ background: "rgba(45,212,200,0.14)", color: "var(--brand-cyan)", border: "1px solid rgba(45,212,200,0.3)" }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--brand-cyan)" }} />
              {hotel ? `${hotel.city ?? "Live"} · live rooms and prices` : "K Hotels · live rooms and prices"}
            </p>
            <h1 className="font-poppins font-semibold text-white mt-5 text-4xl sm:text-6xl leading-[1.05] tracking-tight">
              {hotel ? (
                <>
                  Book your stay at <span style={{ color: "var(--brand-cyan)" }}>{hotel.name}</span>
                </>
              ) : (
                <>
                  Find your stay <span style={{ color: "var(--brand-cyan)" }}>with AI</span>
                </>
              )}
            </h1>
            <p className="mt-4 text-base sm:text-lg max-w-2xl" style={{ color: "var(--rail-text)" }}>
              {hotel
                ? "Tell me when you'd like to stay. I'll check live availability, show you real prices and book your room in this chat."
                : "Search available K Hotels with a simple conversation. Say where and when — I'll find real rooms at real prices and book the one you choose."}
            </p>
          </motion.div>

          <motion.div className="mt-8" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
            {composer}
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Suggested searches">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="text-sm rounded-full px-3.5 py-1.5 transition-colors hover:bg-white/15"
                  style={{ background: "rgba(255,255,255,0.08)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.14)" }}
                  onClick={() => onSend(suggestion)}
                  disabled={disabled}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </motion.div>

          <ul className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs" style={{ color: "var(--rail-text)" }}>
            {[
              { icon: <Zap size={15} />, label: "Answers in seconds" },
              { icon: <BadgeCheck size={15} />, label: "Live availability" },
              { icon: <ShieldCheck size={15} />, label: "No account needed" },
              { icon: <Headset size={15} />, label: "Hotel team on hand" },
            ].map((item) => (
              <li key={item.label} className="flex items-center gap-2">
                <span style={{ color: "var(--brand-cyan)" }}>{item.icon}</span> {item.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {hotel ? <HotelOverview hotel={hotel} /> : <Properties disabled={disabled} onSend={onSend} />}

      <HowItWorks />

      <footer className="px-4 sm:px-6 py-8 text-center text-xs muted">
        InnPilot AI Concierge ·{" "}
        <Link to="/staff" className="underline underline-offset-2">
          For hotel teams
        </Link>
      </footer>
    </main>
  );
}

function Properties({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [hotels, setHotels] = useState<NetworkHotel[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchNetwork(controller.signal)
      .then((network) => setHotels(network.hotels))
      .catch(() => {
        // The list is a courtesy; the concierge works without it.
        if (!controller.signal.aborted) setHotels([]);
      });
    return () => controller.abort();
  }, []);

  if (hotels !== null && hotels.length === 0) return null;

  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-6 py-12" aria-labelledby="properties-title">
      <div className="flex flex-wrap items-end justify-between gap-2 mb-5">
        <div>
          <p className="eyebrow">Participating properties</p>
          <h2 id="properties-title" className="font-poppins text-2xl font-semibold mt-1" style={{ color: "var(--text)" }}>
            One conversation, every K Hotels property
          </h2>
        </div>
        {hotels && <p className="text-sm muted">{hotels.length} hotels searched live</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {hotels === null
          ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 180, borderRadius: 14 }} />)
          : hotels.map((hotel) => {
              const [from, to] = toneFor(hotel.hotel);
              return (
                <button
                  key={hotel.hotel}
                  type="button"
                  className="card overflow-hidden text-left transition-shadow hover:shadow-lg disabled:opacity-60"
                  onClick={() => onSend(`What rooms are available at ${hotel.name}?`)}
                  disabled={disabled}
                >
                  <div className="px-4 pt-3 pb-5" style={{ background: `linear-gradient(135deg, ${from}, ${to})`, color: "#fff" }}>
                    <Building2 size={18} className="opacity-80" />
                    <p className="font-poppins text-lg font-semibold mt-3 leading-tight">{hotel.name}</p>
                    <p className="text-xs mt-0.5 inline-flex items-center gap-1 opacity-90">
                      <MapPin size={12} /> {[hotel.city, hotel.region && `${hotel.region} Region`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    {hotel.description && (
                      <p className="text-sm line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                        {hotel.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                        {hotel.lowestRate !== null ? (
                          <>
                            From <strong style={{ color: "var(--text)" }}>{money(hotel.lowestRate, hotel.currency)}</strong> / night
                          </>
                        ) : (
                          "Rates on request"
                        )}
                      </span>
                      <ArrowRight size={16} style={{ color: "var(--primary)" }} />
                    </div>
                  </div>
                </button>
              );
            })}
      </div>
    </section>
  );
}

function HotelOverview({ hotel }: { hotel: ConciergeHotel }) {
  return (
    <section className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-4">
      {hotel.description && (
        <p className="text-base" style={{ color: "var(--text-secondary)" }}>
          {hotel.description}
        </p>
      )}
      {hotel.amenities.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Amenities">
          {hotel.amenities.map((amenity) => (
            <li key={amenity} className="text-xs rounded-full px-3 py-1" style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
              {amenity}
            </li>
          ))}
        </ul>
      )}
      {hotel.roomTypes.length > 0 && (
        <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
          {hotel.roomTypes.map((type) => (
            <div key={type.roomType} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
              <span className="font-semibold" style={{ color: "var(--text)" }}>
                {type.roomType}
                {type.capacity && <span className="font-normal muted"> · sleeps {type.capacity.to}</span>}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {type.nightlyRate ? (
                  <>
                    {type.nightlyRate.from === type.nightlyRate.to ? "" : "from "}
                    <strong style={{ color: "var(--text)" }}>{money(type.nightlyRate.from, hotel.currency)}</strong> / night
                  </>
                ) : (
                  "Rate on request"
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: <MessagesSquare size={18} />, title: "Ask", text: "Describe your stay in your own words: where, when, what kind of room." },
    { icon: <Building2 size={18} />, title: "Compare", text: "See a few real options with live availability, nightly rates and the total." },
    { icon: <CalendarCheck size={18} />, title: "Book", text: "Pick one, give your name and phone, confirm — and get your booking reference." },
  ];
  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, index) => (
          <div key={step.title} className="card p-5">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "var(--primary-soft)", color: "var(--primary-active)" }}>
                {step.icon}
              </span>
              <p className="font-poppins font-semibold" style={{ color: "var(--text)" }}>
                {index + 1}. {step.title}
              </p>
            </div>
            <p className="text-sm mt-3" style={{ color: "var(--text-secondary)" }}>
              {step.text}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Whole-page states                                                    */
/* ------------------------------------------------------------------ */

function LoadingScreen() {
  return (
    <div className="min-h-[100dvh]" style={{ background: "var(--brand-navy)" }} aria-busy="true">
      <div className="max-w-3xl mx-auto px-6 pt-24 space-y-5">
        <div className="skeleton" style={{ height: 22, width: 180, opacity: 0.2 }} />
        <div className="skeleton" style={{ height: 56, width: "80%", opacity: 0.2 }} />
        <div className="skeleton" style={{ height: 88, opacity: 0.15, borderRadius: 16 }} />
      </div>
      <p className="sr-only">Loading the concierge…</p>
    </div>
  );
}

function CenteredMessage({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-5" style={{ background: "var(--app-bg)" }}>
      <div className="card p-8 max-w-md w-full text-center space-y-3">
        <div className="empty-icon mx-auto">{icon}</div>
        <h1 className="font-poppins text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function NotFoundScreen() {
  return (
    <CenteredMessage icon={<SearchX size={22} />} title="We couldn't find this hotel">
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        This link doesn't match a hotel. You can still search every K Hotels property.
      </p>
      <Link to="/" className="btn btn-primary">
        <AssistantAvatar size={20} /> Search all hotels
      </Link>
    </CenteredMessage>
  );
}

function LoadErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CenteredMessage icon={<Sparkles size={22} />} title="The concierge is taking a break">
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        {message}
      </p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </CenteredMessage>
  );
}
