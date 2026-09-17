/**
 * Inbox — every guest conversation in one place, whichever channel it
 * arrived on.
 *
 * Web conversations are real: the guest AI concierge records them as guests
 * chat. WhatsApp, Instagram and Email are MOCKED in this build — sample
 * threads the hotel adds here, labelled as simulated — to show how one
 * inbox gathers every channel.
 *
 * Each row shows the guest, the latest message, the channel, whether the AI
 * or a person is handling it, the lead score (Phase 5), how far the guest got
 * with a booking, and whether they are owed a follow-up (Phase 6). Staff can
 * take a conversation over, which stops the AI answering, reply, hand it
 * back, and send a suggested follow-up to a guest who was left waiting or
 * went quiet.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, ArrowLeft, BellRing, Bot, Headset, Inbox as InboxIcon, Info, Search, Send, Sparkles } from "lucide-react";

import { useWorkspace } from "../../workspace/workspaceContext";
import { useHotelProfile } from "../../lib/hotelProfile";
import {
  channelCounts,
  CHANNEL_LABEL,
  CHANNELS,
  filterConversations,
  leadCounts,
  LEAD_LABEL,
  LEAD_SCORES,
  MAX_MESSAGE_TEXT,
  CONVERSATION_STATUSES,
  STATUS_LABEL,
  statusCounts,
  type ChannelFilter,
  type LeadFilter,
  type StatusFilter,
} from "../../lib/conversations";
import { draftFollowUp, dueFollowUp, sortFollowUps, type FollowUp } from "../../lib/followUps";
import { LEAD_EMOJI } from "../../lib/leadScoring";
import {
  addSampleConversations,
  sendFollowUp,
  sendStaffReply,
  setClosed,
  setHandler,
  snoozeFollowUp,
  useConversations,
  useMessages,
} from "../../lib/inbox";
import { EmptyState, PageHeader, SegmentedControl, useToast } from "../../components/ui";
import {
  ChannelBadge,
  ConversationRow,
  FollowUpBadge,
  GuestAvatar,
  HandlerBadge,
  LeadBadge,
  LeadReasons,
  MessageBubble,
  SelectedHotelBadge,
  StatusBadge,
} from "./parts";

export default function Inbox() {
  const { hotelId } = useWorkspace();
  const { profile } = useHotelProfile(hotelId);
  const toast = useToast();
  const { conversations, loading, error } = useConversations(hotelId);

  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [lead, setLead] = useState<LeadFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [onlyFollowUps, setOnlyFollowUps] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingSamples, setAddingSamples] = useState(false);

  // Keep row times honest without a refresh.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(() => channelCounts(conversations), [conversations]);
  const leads = useMemo(() => leadCounts(conversations), [conversations]);
  const statuses = useMemo(() => statusCounts(conversations), [conversations]);
  // Who the hotel still owes something, worked out from the thread itself
  // (D21). It moves with the clock, so it follows the minute tick above.
  const followUps = useMemo(() => {
    const due = new Map<string, FollowUp>();
    for (const conversation of conversations) {
      const followUp = dueFollowUp(conversation, now);
      if (followUp) due.set(conversation.id, followUp);
    }
    return due;
  }, [conversations, now]);
  const visible = useMemo(() => {
    const matching = filterConversations(conversations, { channel, lead, status, query: search });
    // Working down the follow-up list means hottest first, longest wait first.
    return onlyFollowUps ? sortFollowUps(matching.filter((c) => followUps.has(c.id)), now) : matching;
  }, [conversations, channel, lead, status, search, onlyFollowUps, followUps, now]);
  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const hasSamples = conversations.some((c) => c.mock);

  const addSamples = async () => {
    if (!hotelId) return;
    setAddingSamples(true);
    const result = await addSampleConversations(hotelId, profile.name);
    setAddingSamples(false);
    if (result.ok) toast.success("Sample WhatsApp, Instagram and Email conversations added");
    else toast.error(result.error);
  };

  const filterOptions = [
    { key: "all" as ChannelFilter, label: `All ${counts.all}` },
    ...CHANNELS.map((c) => ({ key: c as ChannelFilter, label: `${CHANNEL_LABEL[c]} ${counts[c]}` })),
  ];

  const statusOptions = [
    { key: "all" as StatusFilter, label: `All ${statuses.all}` },
    ...CONVERSATION_STATUSES.map((key) => ({ key: key as StatusFilter, label: `${STATUS_LABEL[key]} ${statuses[key]}` })),
  ];

  // Hottest first: the guest a hotel loses money by missing is the one at the top.
  const leadOptions = [
    { key: "all" as LeadFilter, label: `All ${leads.all}` },
    ...LEAD_SCORES.map((score) => ({ key: score as LeadFilter, label: `${LEAD_EMOJI[score]} ${LEAD_LABEL[score]} ${leads[score]}` })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbox"
        subtitle="Guest conversations from the AI Concierge and every channel. Take over any time."
        actions={
          !hasSamples && conversations.length > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={addSamples} disabled={addingSamples}>
              <Sparkles size={14} /> {addingSamples ? "Adding…" : "Add sample conversations"}
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="card p-4 text-sm" role="alert" style={{ color: "var(--danger-text)", borderColor: "var(--danger-border)" }}>
          {error}
        </div>
      )}

      {!loading && conversations.length === 0 ? (
        // A load that failed is not an empty inbox: the error above says so.
        !error && (
          <div className="card">
            <EmptyState
              icon={<InboxIcon size={22} />}
              title="No conversations yet"
              description="Chats from your guest AI concierge appear here as they happen. Add sample WhatsApp, Instagram and Email conversations to see every channel in one inbox."
              action={
                <button type="button" className="btn btn-primary" onClick={addSamples} disabled={addingSamples || !hotelId}>
                  <Sparkles size={15} /> {addingSamples ? "Adding…" : "Add sample conversations"}
                </button>
              }
            />
          </div>
        )
      ) : (
        <div className="card overflow-hidden grid lg:grid-cols-[minmax(320px,400px)_1fr] lg:h-[calc(100vh-12rem)] min-h-[560px]">
          {/* ---------- LIST ---------- */}
          <section
            className={`flex flex-col min-h-0 ${selected ? "hidden lg:flex" : "flex"}`}
            style={{ borderRight: "1px solid var(--border)" }}
            aria-label="Conversations"
          >
            <div className="p-3 space-y-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <SegmentedControl label="Filter by status" value={status} options={statusOptions} onChange={setStatus} />
              <SegmentedControl label="Filter by channel" value={channel} options={filterOptions} onChange={setChannel} />
              <SegmentedControl label="Filter by lead score" value={lead} options={leadOptions} onChange={setLead} />
              <button
                type="button"
                aria-pressed={onlyFollowUps}
                className={`btn btn-sm ${onlyFollowUps ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setOnlyFollowUps((on) => !on)}
                title="Guests left waiting for a reply, and interested guests who went quiet"
              >
                <BellRing size={14} /> Needs follow-up {followUps.size}
              </button>
              <div className="search-wrap">
                <Search size={16} />
                <input
                  className="input"
                  aria-label="Search conversations"
                  placeholder="Search guest, message or reference…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-4 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="skeleton" style={{ height: 72 }} />
                  ))}
                </div>
              ) : visible.length === 0 ? (
                <p className="p-6 text-sm text-center muted">
                  {onlyFollowUps ? "Nobody is waiting on you right now." : "No conversations match this filter."}
                </p>
              ) : (
                visible.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    followUp={followUps.get(conversation.id) ?? null}
                    selected={conversation.id === selectedId}
                    onSelect={() => setSelectedId(conversation.id)}
                    now={now}
                    hotelName={profile.name}
                  />
                ))
              )}
            </div>
          </section>

          {/* ---------- THREAD ---------- */}
          <section className={`flex-col min-h-0 ${selected ? "flex" : "hidden lg:flex"}`} aria-label="Conversation">
            {selected && hotelId ? (
              <Thread
                key={selected.id}
                hotelId={hotelId}
                conversation={selected}
                hotelName={profile.name}
                followUp={followUps.get(selected.id) ?? null}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center p-8">
                <p className="text-sm muted text-center">Select a conversation to read it.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Thread({
  hotelId,
  conversation,
  hotelName,
  followUp,
  onBack,
}: {
  hotelId: string;
  conversation: ReturnType<typeof useConversations>["conversations"][number];
  hotelName: string;
  followUp: FollowUp | null;
  onBack: () => void;
}) {
  const toast = useToast();
  const { messages, loading } = useMessages(hotelId, conversation.id);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const switchHandler = async (handledBy: "ai" | "human") => {
    setBusy(true);
    const result = await setHandler(hotelId, conversation, handledBy);
    setBusy(false);
    if (result.ok) toast.success(handledBy === "human" ? "You're handling this conversation" : "The AI concierge is back on this conversation");
    else toast.error(result.error);
  };

  const reply = async (event: FormEvent) => {
    event.preventDefault();
    // Enter submits the form directly, so the disabled Send button isn't enough.
    if (busy || !draft.trim()) return;
    // The thread shows the reply the moment it's written, so clear the box
    // now rather than after the server confirms; put it back if it fails.
    const text = draft;
    setDraft("");
    setBusy(true);
    const result = await sendStaffReply(hotelId, conversation, text);
    setBusy(false);
    if (!result.ok) {
      setDraft(text);
      toast.error(result.error);
    }
  };

  const toggleClosed = async () => {
    setBusy(true);
    const result = await setClosed(hotelId, conversation, !conversation.closed);
    setBusy(false);
    if (result.ok) toast.success(conversation.closed ? "Conversation reopened" : "Conversation closed");
    else toast.error(result.error);
  };

  const human = conversation.handledBy === "human";

  return (
    <>
      <header className="px-4 py-3 flex flex-wrap items-center gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <button type="button" className="icon-btn lg:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft size={18} />
        </button>
        <GuestAvatar conversation={conversation} size={36} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate" style={{ color: "var(--text)" }}>
            {conversation.guestName}
          </p>
          <p className="text-xs muted truncate">
            {conversation.guestContact || "No contact details yet"}
            {conversation.reservationId && ` · ${conversation.reservationId}`}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={toggleClosed}
          disabled={busy}
          title={conversation.closed ? "Reopen this conversation" : "Mark this conversation closed"}
        >
          {conversation.closed ? <ArchiveRestore size={14} /> : <Archive size={14} />} {conversation.closed ? "Reopen" : "Close"}
        </button>
        {human ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => switchHandler("ai")} disabled={busy}>
            <Bot size={14} /> Return to AI
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => switchHandler("human")} disabled={busy}>
            <Headset size={14} /> Take over
          </button>
        )}
        <div className="w-full flex flex-wrap gap-1.5">
          <ChannelBadge channel={conversation.channel} mock={conversation.mock} />
          <HandlerBadge handledBy={conversation.handledBy} />
          <LeadBadge lead={conversation.lead} />
          <StatusBadge conversation={conversation} />
          <SelectedHotelBadge conversation={conversation} hotelName={hotelName} />
          <FollowUpBadge followUp={followUp} />
          <LeadReasons lead={conversation.lead} />
        </div>
      </header>

      {conversation.mock && (
        <p className="px-4 py-2 text-xs flex items-center gap-2" style={{ background: "var(--warning-soft)", color: "var(--warning-text)" }}>
          <Info size={13} /> Sample {CHANNEL_LABEL[conversation.channel]} conversation. This channel is simulated in the demo; replies are recorded here, not sent.
        </p>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-[240px]" aria-live="polite">
        {loading && messages.length === 0 ? (
          <div className="space-y-3">
            <div className="skeleton" style={{ height: 48, width: "60%" }} />
            <div className="skeleton ml-auto" style={{ height: 48, width: "50%" }} />
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} guestName={conversation.guestName} />)
        )}
      </div>

      {followUp && (
        <FollowUpCard
          key={`${conversation.id}-${followUp.kind}`}
          hotelId={hotelId}
          conversation={conversation}
          hotelName={hotelName}
          followUp={followUp}
        />
      )}

      <div className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
        {human ? (
          <form onSubmit={reply} className="flex items-end gap-2">
            <label htmlFor="staff-reply" className="sr-only">
              Reply to {conversation.guestName}
            </label>
            <textarea
              id="staff-reply"
              className="input resize-none"
              rows={2}
              maxLength={MAX_MESSAGE_TEXT}
              placeholder={`Reply to ${conversation.guestName}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" className="btn btn-primary shrink-0" disabled={busy || !draft.trim()}>
              <Send size={15} /> Send
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            <span className="flex items-center gap-2">
              <Bot size={16} style={{ color: "var(--primary)" }} /> The AI concierge is answering this guest.
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => switchHandler("human")} disabled={busy}>
              <Headset size={14} /> Take over to reply
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The suggested follow-up, above the composer: what this guest is owed, a
 * draft written from what they themselves said (D21), and the two things
 * staff can do about it.
 *
 * The draft is a starting point, not a send button: it is loaded into an
 * editable box, and nothing leaves the hotel until someone presses Send.
 */
function FollowUpCard({
  hotelId,
  conversation,
  hotelName,
  followUp,
}: {
  hotelId: string;
  conversation: ReturnType<typeof useConversations>["conversations"][number];
  hotelName: string;
  followUp: FollowUp;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftFollowUp(conversation, hotelName, followUp.kind));
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !draft.trim()) return;
    setBusy(true);
    const result = await sendFollowUp(hotelId, conversation, draft);
    setBusy(false);
    if (result.ok) toast.success(`Follow-up sent to ${conversation.guestName}`);
    else toast.error(result.error);
  };

  const notNow = async () => {
    setBusy(true);
    const result = await snoozeFollowUp(hotelId, conversation);
    setBusy(false);
    if (result.ok) toast.success("Put off for a day");
    else toast.error(result.error);
  };

  return (
    <form
      onSubmit={send}
      className="px-4 py-3 space-y-2"
      style={{ borderTop: "1px solid var(--primary-border)", background: "var(--primary-soft)" }}
      aria-label="Suggested follow-up"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--primary-active)" }}>
          <BellRing size={14} /> Suggested follow-up
        </p>
        <p className="text-xs muted">{followUp.reason}</p>
      </div>
      <label htmlFor="follow-up-draft" className="sr-only">
        Follow-up to {conversation.guestName}
      </label>
      <textarea
        id="follow-up-draft"
        className="input resize-none"
        rows={3}
        maxLength={MAX_MESSAGE_TEXT}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs muted">Edit it before you send. Your AI concierge stays on this chat and can take the guest's answer from there.</p>
        <span className="flex gap-2 shrink-0">
          <button type="button" className="btn btn-secondary btn-sm" onClick={notNow} disabled={busy}>
            Not now
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()}>
            <Send size={14} /> Send follow-up
          </button>
        </span>
      </div>
    </form>
  );
}
