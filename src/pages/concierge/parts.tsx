/**
 * Pieces of the AI Concierge conversation: message bubbles, hotel result
 * cards, one hotel's availability, the booking summary, the confirmation,
 * and the waiting and failure states.
 *
 * Every figure on a card comes from the tools' own results (the reply's
 * `search`, `availability`, `quote` and `booking`), never from the model's
 * prose. Buttons only ever send a message in the guest's voice: the
 * conversation, and the server's checks, decide what happens next.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  BedDouble,
  CalendarDays,
  Check,
  CheckCircle2,
  Copy,
  Headset,
  Mail,
  MapPin,
  Moon,
  Pencil,
  Phone,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

import { CONFIRM_BOOKING_MESSAGE } from "../../lib/confirmation";
import { money, plural } from "../../lib/format";
import {
  chooseOptionMessage,
  chooseRoomTypeMessage,
  parseReply,
  stayDay,
  stayRange,
  toneFor,
  type ChatEntry,
  type ConciergeAvailability,
  type ConciergeBooking,
  type ConciergeOption,
  type ConciergeQuote,
  type ConciergeSearch,
} from "../../lib/concierge";

/* ------------------------------------------------------------------ */
/* Text                                                                 */
/* ------------------------------------------------------------------ */

/** Renders parsed reply text as React nodes: bold and bullets only, never HTML. */
function ReplyText({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {parseReply(text).map((block, i) =>
        block.kind === "paragraph" ? (
          <p key={i}>
            {block.spans.map((span, j) => (span.bold ? <strong key={j}>{span.text}</strong> : <span key={j}>{span.text}</span>))}
          </p>
        ) : (
          <ul key={i} className="list-disc pl-5 space-y-1">
            {block.items.map((item, j) => (
              <li key={j}>
                {item.map((span, k) => (span.bold ? <strong key={k}>{span.text}</strong> : <span key={k}>{span.text}</span>))}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

export function AssistantAvatar({ size = 32 }: { size?: number }) {
  return (
    <span
      className="shrink-0 rounded-full flex items-center justify-center"
      style={{ width: size, height: size, background: "linear-gradient(135deg, var(--brand-teal), var(--brand-cyan))", color: "#fff" }}
      aria-hidden
    >
      <Sparkles size={Math.round(size * 0.47)} />
    </span>
  );
}

export interface EntryActions {
  disabled: boolean;
  onSend: (text: string) => void;
  /** Puts the cursor in the composer, e.g. to change a booking detail. */
  onEdit: () => void;
}

export function MessageBubble({ entry, actions }: { entry: ChatEntry; actions: EntryActions }) {
  if (entry.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%]">
          <div
            className="rounded-2xl rounded-br-md px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words"
            style={{ background: "var(--brand-navy)", color: "#fff", opacity: entry.failed ? 0.6 : 1 }}
          >
            {entry.text}
          </div>
          {entry.failed && (
            <p className="text-xs mt-1 text-right" style={{ color: "var(--danger-text)" }}>
              Not delivered
            </p>
          )}
        </div>
      </motion.div>
    );
  }

  if (entry.from === "staff") {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 items-start">
        <span
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: "var(--warning-soft)", color: "var(--warning-text)" }}
          aria-hidden
        >
          <Headset size={15} />
        </span>
        <div className="min-w-0 max-w-[92%] sm:max-w-[80%]">
          <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>
            Hotel team
          </p>
          <div
            className="rounded-2xl rounded-tl-md px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words"
            style={{ background: "var(--warning-soft)", border: "1px solid var(--warning-border)", color: "var(--text)" }}
          >
            {entry.text}
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 items-start">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 space-y-3">
        {entry.text && (
          <div
            className="rounded-2xl rounded-tl-md px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words w-fit max-w-full sm:max-w-[85%]"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          >
            <ReplyText text={entry.text} />
          </div>
        )}
        {entry.search && <SearchResults search={entry.search} actions={actions} />}
        {entry.availability && <AvailabilityCard availability={entry.availability} actions={actions} />}
        {entry.quote && !entry.booking && <BookingSummaryCard quote={entry.quote} actions={actions} />}
        {entry.booking && <BookingConfirmedCard booking={entry.booking} />}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Waiting and failing                                                  */
/* ------------------------------------------------------------------ */

const WAITING_STEPS = [
  "Understanding your request…",
  "Searching K Hotels properties…",
  "Checking live availability and prices…",
  "Almost there…",
];

export function TypingIndicator() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, WAITING_STEPS.length - 1)), 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex gap-2.5 items-center" role="status" aria-live="polite">
      <AssistantAvatar />
      <div
        className="rounded-2xl rounded-tl-md px-4 py-3 flex items-center gap-3"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: "var(--primary)" }}
              animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
              transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
            />
          ))}
        </span>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {WAITING_STEPS[step]}
        </span>
      </div>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex gap-2.5 items-start" role="alert">
      <span
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
        style={{ background: "var(--danger-soft)", color: "var(--danger-text)" }}
        aria-hidden
      >
        <AlertCircle size={16} />
      </span>
      <div
        className="rounded-2xl rounded-tl-md px-4 py-3 text-sm space-y-2.5 max-w-[92%] sm:max-w-[80%]"
        style={{ background: "var(--danger-soft)", border: "1px solid var(--danger-border)", color: "var(--danger-text)" }}
      >
        <p>{message}</p>
        {onRetry && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            <RotateCcw size={14} /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Search results                                                       */
/* ------------------------------------------------------------------ */

function availabilityLabel(rooms: number): string {
  return rooms === 1 ? "Last room available" : `${rooms} rooms available`;
}

export function SearchResults({ search, actions }: { search: ConciergeSearch; actions: EntryActions }) {
  const alternatives = search.options.some((option) => !option.matchesRequestedRoomType);
  return (
    <section aria-label="Available options" className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--text)" }}>
          <CalendarDays size={14} /> {stayRange(search.checkIn, search.checkOut)}
        </span>
        <span>{plural(search.nights, "night")}</span>
        {search.destination && (
          <span className="inline-flex items-center gap-1">
            <MapPin size={12} /> {search.destination}
          </span>
        )}
        <span className="inline-flex items-center gap-1" style={{ color: "var(--success-text)" }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} /> Live availability ·{" "}
          {plural(search.hotelsSearched, "hotel")} searched
        </span>
      </div>
      {alternatives && search.roomType && (
        <p className="text-xs" style={{ color: "var(--warning-text)" }}>
          No {search.roomType} room is free for these dates. These are other rooms available.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {search.options.map((option) => (
          <OptionCard key={`${option.hotel}-${option.roomType}`} option={option} actions={actions} />
        ))}
      </div>
    </section>
  );
}

function OptionCard({ option, actions }: { option: ConciergeOption; actions: EntryActions }) {
  const [from, to] = toneFor(option.hotel);
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: option.optionNumber * 0.05 }}
      className="card overflow-hidden flex flex-col"
      aria-label={`Option ${option.optionNumber}: ${option.roomType} at ${option.hotelName}`}
    >
      <div className="relative px-4 pt-3 pb-4" style={{ background: `linear-gradient(135deg, ${from}, ${to})`, color: "#fff" }}>
        <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide opacity-90">
          <span>Option {option.optionNumber}</span>
          <span className="rounded-full px-2 py-0.5" style={{ background: "rgba(255,255,255,0.18)" }}>
            {availabilityLabel(option.availableRooms)}
          </span>
        </div>
        <h3 className="font-poppins text-lg font-semibold mt-3 leading-tight">{option.hotelName}</h3>
        <p className="text-xs mt-0.5 inline-flex items-center gap-1 opacity-90">
          <MapPin size={12} /> {[option.city, option.region && `${option.region} Region`].filter(Boolean).join(" · ")}
        </p>
      </div>

      <div className="px-4 py-3 flex-1 space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" style={{ color: "var(--text)" }}>
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <BedDouble size={15} style={{ color: "var(--primary)" }} /> {option.roomType}
          </span>
          {option.capacity !== null && (
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              <Users size={13} /> Sleeps {option.capacity}
            </span>
          )}
        </div>
        {option.amenities.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Amenities">
            {option.amenities.slice(0, 5).map((amenity) => (
              <li key={amenity} className="text-[11px] rounded-full px-2 py-0.5" style={{ background: "var(--surface-muted)", color: "var(--text-secondary)" }}>
                {amenity}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 pb-4 pt-1 flex items-end justify-between gap-3">
        <div>
          <p className="font-poppins text-xl font-semibold leading-none" style={{ color: "var(--text)" }}>
            {money(option.nightlyRate, option.currency)}
            <span className="text-xs font-normal font-sans" style={{ color: "var(--text-muted)" }}>
              {" "}
              / night
            </span>
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
            {plural(option.nights, "night")} · <strong style={{ color: "var(--text)" }}>{money(option.stayTotal, option.currency)}</strong> total
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm shrink-0"
          disabled={actions.disabled}
          onClick={() => actions.onSend(chooseOptionMessage(option))}
        >
          Choose
        </button>
      </div>
    </motion.article>
  );
}

/* ------------------------------------------------------------------ */
/* One hotel's availability                                             */
/* ------------------------------------------------------------------ */

export function AvailabilityCard({ availability, actions }: { availability: ConciergeAvailability; actions: EntryActions }) {
  const { checkIn, checkOut, nights, currency, roomTypes, totalAvailable, hotelName } = availability;
  return (
    <div className="card overflow-hidden">
      <div
        className="px-4 py-3 flex flex-wrap items-center justify-between gap-2"
        style={{ background: "var(--primary-soft)", borderBottom: "1px solid var(--primary-border)" }}
      >
        <span className="text-sm font-semibold" style={{ color: "var(--primary-active)" }}>
          {hotelName}
        </span>
        <span className="text-xs inline-flex items-center gap-1.5" style={{ color: "var(--primary-active)" }}>
          <CalendarDays size={13} /> {stayRange(checkIn, checkOut)} · {plural(nights, "night")}
        </span>
      </div>
      {totalAvailable === 0 ? (
        <p className="px-4 py-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          Nothing is free here for these dates. Ask me to search other dates or other hotels.
        </p>
      ) : (
        <ul>
          {roomTypes.map((type, index) => (
            <li
              key={type.roomType}
              className="px-4 py-3 flex flex-wrap items-center justify-between gap-3"
              style={{ borderTop: index ? "1px solid var(--border)" : undefined }}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-semibold" style={{ color: "var(--text)" }}>
                  <BedDouble size={15} style={{ color: "var(--primary)" }} /> {type.roomType}
                </span>
                <span className="block text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  {availabilityLabel(type.availableRooms)}
                  {type.capacity !== null && ` · sleeps ${type.capacity}`} · {money(type.nightlyRate, currency)} / night ·{" "}
                  <strong style={{ color: "var(--text)" }}>{money(type.stayTotal, currency)}</strong> total
                </span>
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={actions.disabled}
                onClick={() => actions.onSend(chooseRoomTypeMessage(type.roomType, hotelName))}
              >
                Choose
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Booking summary                                                      */
/* ------------------------------------------------------------------ */

function StayRows({ item }: { item: ConciergeQuote | ConciergeBooking }) {
  return (
    <>
      <div className="kv">
        <span className="kv-label">Hotel</span>
        <span className="kv-value text-right">
          {item.hotelName}
          {item.city && <span className="block text-xs font-normal muted">{item.city}</span>}
        </span>
      </div>
      <div className="kv">
        <span className="kv-label">Room</span>
        <span className="kv-value">{item.roomType}</span>
      </div>
      <div className="kv">
        <span className="kv-label">Check-in</span>
        <span className="kv-value">{stayDay(item.checkIn)}</span>
      </div>
      <div className="kv">
        <span className="kv-label">Check-out</span>
        <span className="kv-value">{stayDay(item.checkOut)}</span>
      </div>
      <div className="kv">
        <span className="kv-label">Nights</span>
        <span className="kv-value">
          {item.nights} · {plural(item.numberOfGuests, "guest")}
        </span>
      </div>
      <div className="kv">
        <span className="kv-label">Guest</span>
        <span className="kv-value">{item.guestName}</span>
      </div>
      <div className="kv kv-total">
        <span className="kv-label">Total</span>
        <span className="kv-value">{money(item.totalPrice, item.currency)}</span>
      </div>
    </>
  );
}

export function BookingSummaryCard({ quote, actions }: { quote: ConciergeQuote; actions: EntryActions }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card overflow-hidden max-w-md"
      style={{ borderColor: "var(--primary-border)" }}
      aria-label="Booking summary"
    >
      <div className="px-4 py-3 flex items-center justify-between gap-2" style={{ background: "var(--primary-soft)" }}>
        <p className="eyebrow" style={{ color: "var(--primary-active)" }}>
          Booking summary
        </p>
        <span className="text-[11px] inline-flex items-center gap-1" style={{ color: "var(--success-text)" }}>
          <ShieldCheck size={13} /> Availability re-checked
        </span>
      </div>
      <div className="px-4 py-2">
        <StayRows item={quote} />
        <p className="text-xs muted mt-1 mb-2">
          {money(quote.nightlyRate, quote.currency)} × {plural(quote.nights, "night")} · Phone {quote.guestPhone}
        </p>
      </div>
      <div className="px-4 pb-4 pt-1 space-y-2">
        <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
          Would you like me to confirm this booking?
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={actions.disabled}
            onClick={() => actions.onSend(CONFIRM_BOOKING_MESSAGE)}
          >
            <Check size={16} /> Confirm booking
          </button>
          <button type="button" className="btn btn-ghost" disabled={actions.disabled} onClick={actions.onEdit}>
            <Pencil size={14} /> Change something
          </button>
        </div>
        <p className="text-[11px] muted">Nothing is booked until you confirm. No payment is taken online.</p>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                         */
/* ------------------------------------------------------------------ */

export function BookingConfirmedCard({ booking }: { booking: ConciergeBooking }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(booking.reservationId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked: the reference is still selectable on screen.
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="card overflow-hidden max-w-md"
      style={{ borderColor: "var(--success-border)" }}
      aria-label="Booking confirmation"
    >
      <div className="px-4 py-4 flex items-center gap-3" style={{ background: "var(--success-soft)" }}>
        <CheckCircle2 size={32} style={{ color: "var(--success)" }} />
        <div className="min-w-0">
          <h3 className="font-poppins font-semibold text-lg leading-tight" style={{ color: "var(--success-text)" }}>
            Booking Confirmed
          </h3>
          <p className="text-xs" style={{ color: "var(--success-text)" }}>
            {booking.hotelName} has your reservation.
          </p>
        </div>
      </div>

      <div className="px-4 pt-3">
        <p className="eyebrow">Booking reference</p>
        <div className="flex items-center gap-2 mt-1">
          <code className="text-lg font-semibold tracking-wide select-all" style={{ color: "var(--text)" }}>
            {booking.reservationId}
          </code>
          <button type="button" className="icon-btn" onClick={copy} aria-label="Copy booking reference">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      </div>

      <div className="px-4 py-2">
        <StayRows item={booking} />
      </div>

      <div className="px-4 py-3 text-xs space-y-2" style={{ borderTop: "1px solid var(--border)", color: "var(--text-secondary)" }}>
        <p className="inline-flex items-center gap-1.5">
          <Moon size={13} /> Nothing has been charged. Payment is settled with the hotel.
        </p>
        {(booking.hotelPhone || booking.hotelEmail) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {booking.hotelPhone && (
              <a href={`tel:${booking.hotelPhone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5">
                <Phone size={13} /> {booking.hotelPhone}
              </a>
            )}
            {booking.hotelEmail && (
              <a href={`mailto:${booking.hotelEmail}`} className="inline-flex items-center gap-1.5">
                <Mail size={13} /> {booking.hotelEmail}
              </a>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
