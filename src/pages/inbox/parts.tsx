/**
 * Pieces of the unified inbox: channel, lead and follow-up badges, a
 * conversation row, and a message bubble.
 */
import type { ReactNode } from "react";
import { BellRing, Bot, Building2, Globe, Headset, Instagram, Mail, MessageCircle } from "lucide-react";

import {
  BOOKING_STATE_LABEL,
  CHANNEL_LABEL,
  conversationStatus,
  selectedHotelLabel,
  STATUS_LABEL,
  LEAD_LABEL,
  relativeTime,
  snippet,
  type Channel,
  type Conversation,
  type ConversationBookingState,
  type ConversationMessage,
  type Handler,
  type LeadAssessment,
} from "../../lib/conversations";
import { FOLLOW_UP_KIND_LABEL, waitedLabel, type FollowUp } from "../../lib/followUps";
import { LEAD_EMOJI, LEAD_MEANING } from "../../lib/leadScoring";
import { dateTime } from "../../lib/format";

const CHANNEL_STYLE: Record<Channel, { icon: ReactNode; color: string; soft: string }> = {
  web: { icon: <Globe size={12} />, color: "var(--primary-active)", soft: "var(--primary-soft)" },
  whatsapp: { icon: <MessageCircle size={12} />, color: "#15803d", soft: "#ecfdf3" },
  instagram: { icon: <Instagram size={12} />, color: "#be185d", soft: "#fdf2f8" },
  email: { icon: <Mail size={12} />, color: "var(--info-text)", soft: "var(--info-soft)" },
};

export function ChannelBadge({ channel, mock }: { channel: Channel; mock?: boolean }) {
  const style = CHANNEL_STYLE[channel];
  return (
    <span
      className="badge badge-plain"
      style={{ background: style.soft, color: style.color, borderColor: "transparent" }}
      title={mock ? `${CHANNEL_LABEL[channel]} (simulated in this demo)` : CHANNEL_LABEL[channel]}
    >
      {style.icon} {CHANNEL_LABEL[channel]}
    </span>
  );
}

export function HandlerBadge({ handledBy }: { handledBy: Handler }) {
  return handledBy === "ai" ? (
    <span className="badge badge-plain badge-info">
      <Bot size={12} /> AI
    </span>
  ) : (
    <span className="badge badge-plain badge-warning">
      <Headset size={12} /> Human
    </span>
  );
}

export function BookingBadge({ status }: { status: ConversationBookingState }) {
  const tone = status === "booked" ? "badge-success" : status === "quoted" ? "badge-info" : "badge-neutral";
  return <span className={`badge ${tone}`}>{BOOKING_STATE_LABEL[status]}</span>;
}

/** New / Active / Booked / Closed (D29). "Closed" says why when the guest booked elsewhere. */
export function StatusBadge({ conversation }: { conversation: Conversation }) {
  const status = conversationStatus(conversation);
  const tone = { new: "badge-neutral", active: "badge-info", booked: "badge-success", closed: "badge-neutral" }[status];
  const title =
    status === "closed" && conversation.bookedElsewhere && !conversation.closed
      ? `Booked at ${conversation.selectedHotelName || "another property"}`
      : BOOKING_STATE_LABEL[conversation.bookingStatus];
  return (
    <span className={`badge ${tone}`} title={title}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The hotel a network guest chose, when they chose one. */
export function SelectedHotelBadge({ conversation, hotelName }: { conversation: Conversation; hotelName: string }) {
  const label = selectedHotelLabel(conversation, hotelName);
  if (!label) return null;
  const here = conversation.selection === "this";
  return (
    <span
      className={`badge badge-plain ${here ? "badge-success" : "badge-neutral"}`}
      title={here ? "The guest chose your hotel" : "The guest chose another K Hotels property"}
    >
      <Building2 size={12} /> {label}
    </span>
  );
}

/**
 * How close this guest is to booking. The reasons are in the tooltip, so
 * staff can always see what the score was based on (D20). A conversation
 * from before scoring existed reads "not scored" until its next message.
 */
export function LeadBadge({ lead }: { lead: LeadAssessment | null }) {
  if (!lead) {
    return (
      <span className="badge badge-plain badge-neutral" title="Scored on the guest's next message">
        Lead: not scored
      </span>
    );
  }
  const tone = lead.score === "hot" ? "badge-danger" : lead.score === "warm" ? "badge-warning" : lead.score === "vip" ? "badge-success" : "badge-neutral";
  return (
    <span className={`badge badge-plain ${tone}`} title={`${LEAD_MEANING[lead.score]}: ${lead.reasons.join(", ").toLowerCase()}`}>
      <span aria-hidden>{LEAD_EMOJI[lead.score]}</span> {LEAD_LABEL[lead.score]}
    </span>
  );
}

/** Why this guest scored as they did, spelled out at the top of a thread. */
export function LeadReasons({ lead }: { lead: LeadAssessment | null }) {
  if (!lead) return null;
  return (
    <p className="text-xs muted w-full">
      <span style={{ color: "var(--text-secondary)" }}>{LEAD_MEANING[lead.score]}</span>
      {lead.reasons.length > 0 && ` — ${lead.reasons.join(" · ")}`}
    </p>
  );
}

/**
 * A guest this hotel still owes something (D21). The wait is on the badge
 * because it is the whole decision: who has been left longest.
 */
export function FollowUpBadge({ followUp }: { followUp: FollowUp | null }) {
  if (!followUp) return null;
  return (
    <span
      className="badge badge-plain"
      style={{ background: "var(--primary-soft)", color: "var(--primary-active)", borderColor: "var(--primary-border)" }}
      title={`${FOLLOW_UP_KIND_LABEL[followUp.kind]} — ${followUp.reason}`}
    >
      <BellRing size={12} /> Follow up · {waitedLabel(followUp.hours)}
    </span>
  );
}

export function GuestAvatar({ conversation, size = 40 }: { conversation: Conversation; size?: number }) {
  const initials =
    conversation.guestName
      .replace(/^@/, "")
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "G";
  const style = CHANNEL_STYLE[conversation.channel];
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span
        className="w-full h-full rounded-full flex items-center justify-center text-sm font-semibold"
        style={{ background: "var(--surface-muted)", color: "var(--text-secondary)" }}
      >
        {initials}
      </span>
      <span
        className="absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center"
        style={{ background: style.soft, color: style.color, border: "2px solid var(--surface)" }}
      >
        {style.icon}
      </span>
    </span>
  );
}

const ROLE_PREFIX: Record<string, string> = { ai: "AI: ", staff: "You: ", guest: "" };

export function ConversationRow({
  conversation,
  followUp,
  selected,
  onSelect,
  now,
  hotelName,
}: {
  conversation: Conversation;
  followUp: FollowUp | null;
  selected: boolean;
  onSelect: () => void;
  now: Date;
  hotelName: string;
}) {
  const last = conversation.lastMessage;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className="w-full text-left px-4 py-3 flex gap-3 transition-colors"
      style={{
        background: selected ? "var(--primary-soft)" : undefined,
        borderLeft: `3px solid ${selected ? "var(--primary)" : "transparent"}`,
        borderBottom: "1px solid var(--border)",
      }}
    >
      <GuestAvatar conversation={conversation} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-semibold truncate" style={{ color: "var(--text)" }}>
            {conversation.guestName}
          </span>
          <span className="text-xs muted shrink-0">{relativeTime(last?.at ?? conversation.updatedAt, now)}</span>
        </span>
        <span className="block text-sm truncate mt-0.5" style={{ color: "var(--text-secondary)" }}>
          {last ? `${ROLE_PREFIX[last.role]}${snippet(last.text)}` : "No messages yet"}
        </span>
        <span className="flex flex-wrap gap-1.5 mt-2">
          <ChannelBadge channel={conversation.channel} mock={conversation.mock} />
          <HandlerBadge handledBy={conversation.handledBy} />
          <LeadBadge lead={conversation.lead} />
          <StatusBadge conversation={conversation} />
          <SelectedHotelBadge conversation={conversation} hotelName={hotelName} />
          <FollowUpBadge followUp={followUp} />
        </span>
      </span>
    </button>
  );
}

const ROLE_LABEL = { guest: "", ai: "AI concierge", staff: "Staff" } as const;

export function MessageBubble({ message, guestName }: { message: ConversationMessage; guestName: string }) {
  const fromGuest = message.role === "guest";
  const background = fromGuest ? "var(--surface-muted)" : message.role === "ai" ? "var(--primary-soft)" : "var(--primary)";
  const color = message.role === "staff" ? "#fff" : "var(--text)";
  return (
    <div className={`flex ${fromGuest ? "justify-start" : "justify-end"}`}>
      <div className="max-w-[85%] sm:max-w-[70%]">
        <p className={`text-[11px] mb-1 flex items-center gap-1.5 ${fromGuest ? "" : "justify-end"}`} style={{ color: "var(--text-muted)" }}>
          {message.role === "ai" && <Bot size={12} />}
          {message.role === "staff" && <Headset size={12} />}
          <span>{fromGuest ? guestName : ROLE_LABEL[message.role]}</span>
          <span>· {dateTime(message.at)}</span>
        </p>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${fromGuest ? "rounded-tl-md" : "rounded-tr-md"}`}
          style={{ background, color, border: message.role === "ai" ? "1px solid var(--primary-border)" : undefined }}
        >
          {message.text.replace(/\*\*/g, "")}
        </div>
      </div>
    </div>
  );
}
