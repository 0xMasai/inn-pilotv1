/**
 * Settings — hotel profile, workspace identity and the activity log.
 *
 * Workspaces have no user accounts, so there are no people to administer:
 * this screen covers how the hotel presents itself, the id that opens the
 * workspace, and the append-only record of what changed.
 */
import { useEffect, useMemo, useState } from "react";
import { limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { Activity, Building2, Check, Copy, ExternalLink, Globe, KeyRound, Search, Sparkles } from "lucide-react";

import { useWorkspace } from "../workspace/workspaceContext";
import { COLLECTIONS } from "../lib/collections";
import { hotelCollection } from "../lib/hotelScope";
import type { AuditEntity } from "../lib/audit";
import {
  CURRENCIES,
  publishConciergeLink,
  saveConciergeListing,
  saveHotelProfile,
  useHotelProfile,
  type EditableProfile,
  type HotelProfile,
} from "../lib/hotelProfile";
import { parseAmenityList, toHotelListing, type HotelListing } from "../lib/hotelListing";
import { toDateSafe } from "../lib/metrics";
import { dateTime } from "../lib/format";
import {
  Card,
  EmptyState,
  Field,
  FormError,
  PageHeader,
  SegmentedControl,
  TableSkeleton,
  useToast,
} from "../components/ui";

type Tab = "hotel" | "activity";

const AUDIT_LIMIT = 200;

const TABS: { key: Tab; label: string }[] = [
  { key: "hotel", label: "Hotel" },
  { key: "activity", label: "Activity" },
];

const ENTITY_FILTERS: { value: "All" | AuditEntity; label: string }[] = [
  { value: "All", label: "All activity" },
  { value: "booking", label: "Bookings" },
  { value: "room", label: "Rooms" },
  { value: "order", label: "Restaurant orders" },
  { value: "product", label: "Bar products" },
  { value: "sale", label: "Bar sales" },
  { value: "transfer", label: "Stock transfers" },
  { value: "parking", label: "Parking" },
  { value: "expense", label: "Expenses" },
  { value: "settings", label: "Settings" },
];

interface AuditRow {
  id: string;
  action: string;
  entity: AuditEntity;
  details: string;
  at: unknown;
  /** Only on entries recorded before workspaces replaced accounts. */
  userEmail?: string;
}

export default function Settings() {
  const { hotelId } = useWorkspace();
  const { profile, loading: profileLoading } = useHotelProfile(hotelId);
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("hotel");

  // ---- Hotel profile ----
  const [draft, setDraft] = useState<EditableProfile | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [copied, setCopied] = useState(false);

  // Seed the form from the live document once it arrives.
  useEffect(() => {
    if (profileLoading) return;
    setDraft((current) =>
      current
        ? current
        : {
            name: profile.name,
            location: profile.location,
            currency: profile.currency,
            phone: profile.phone,
            email: profile.email,
            taxId: profile.taxId,
          }
    );
  }, [profile, profileLoading]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    return (
      draft.name !== profile.name ||
      draft.location !== profile.location ||
      draft.currency !== profile.currency ||
      draft.phone !== profile.phone ||
      draft.email !== profile.email ||
      draft.taxId !== profile.taxId
    );
  }, [draft, profile]);

  const saveProfile = async () => {
    if (!hotelId || !draft) return;
    setSavingProfile(true);
    setProfileError("");
    const result = await saveHotelProfile(hotelId, draft);
    setSavingProfile(false);
    if (result.ok) toast.success("Hotel settings saved");
    else setProfileError(result.error);
  };

  const copyWorkspaceId = async () => {
    if (!hotelId) return;
    try {
      await navigator.clipboard.writeText(hotelId);
      setCopied(true);
      toast.success("Workspace ID copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy automatically. Select the ID and copy it instead.");
    }
  };

  // ---- Activity ----
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditEntity, setAuditEntity] = useState<"All" | AuditEntity>("All");

  useEffect(() => {
    if (!hotelId) {
      setAuditLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(hotelCollection(hotelId, COLLECTIONS.AUDIT), orderBy("at", "desc"), limit(AUDIT_LIMIT)),
      (snap) => {
        setAudit(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditRow, "id">) })));
        setAuditLoading(false);
      },
      (err) => {
        console.error("Failed to read the activity log:", err);
        setAuditLoading(false);
      }
    );
    return () => unsub();
  }, [hotelId]);

  const visibleAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    return audit.filter((r) => {
      if (auditEntity !== "All" && r.entity !== auditEntity) return false;
      if (!q) return true;
      return (
        r.action.toLowerCase().includes(q) ||
        (r.details ?? "").toLowerCase().includes(q)
      );
    });
  }, [audit, auditSearch, auditEntity]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Hotel profile, workspace and activity history"
        actions={
          <SegmentedControl label="Settings section" value={tab} options={TABS} onChange={setTab} />
        }
      />

      {/* ---------- HOTEL ---------- */}
      {tab === "hotel" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
          <Card className="lg:col-span-2" title="Hotel Profile">
            {profileLoading || !draft ? (
              <div className="space-y-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ height: 62 }} />
                ))}
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveProfile();
                }}
              >
                <FormError message={profileError} />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <Field label="Hotel name" required>
                      <input
                        className="input"
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </Field>
                  </div>

                  <Field label="Location">
                    <input
                      className="input"
                      value={draft.location}
                      onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                      placeholder="City, country"
                    />
                  </Field>

                  <Field
                    label="Currency"
                    required
                    hint="Applies to every amount shown across InnPilot."
                  >
                    <select
                      className="select"
                      value={draft.currency}
                      onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Phone">
                    <input
                      className="input"
                      value={draft.phone}
                      onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                      placeholder="+256 7xx xxx xxx"
                    />
                  </Field>

                  <Field label="Email">
                    <input
                      type="email"
                      className="input"
                      value={draft.email}
                      onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                    />
                  </Field>

                  <div className="sm:col-span-2">
                    <Field label="Tax / TIN" hint="Printed on receipts and vouchers.">
                      <input
                        className="input"
                        value={draft.taxId}
                        onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      setDraft({
                        name: profile.name,
                        location: profile.location,
                        currency: profile.currency,
                        phone: profile.phone,
                        email: profile.email,
                        taxId: profile.taxId,
                      })
                    }
                    disabled={!dirty || savingProfile}
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!dirty || savingProfile}
                  >
                    {savingProfile ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </form>
            )}
          </Card>

          <div className="space-y-5">
          <ConciergeLinkCard hotelId={hotelId} hotelName={profile.name} publicId={profile.publicId} loading={profileLoading} />
          {!profileLoading && hotelId && (
            <ConciergeListingCard key={`${hotelId}-${profile.publicId}`} hotelId={hotelId} profile={profile} />
          )}

          <Card title="Workspace">
            <div>
              <div className="kv">
                <span className="kv-label">Plan</span>
                <span className="kv-value" style={{ textTransform: "capitalize" }}>
                  {profile.plan}
                </span>
              </div>
              <div className="kv">
                <span className="kv-label">Status</span>
                <span className="kv-value">
                  <span
                    className={`badge ${profile.planStatus === "active" ? "badge-success" : "badge-warning"}`}
                  >
                    {profile.planStatus}
                  </span>
                </span>
              </div>
            </div>

            <div className="mt-4">
              <p className="field-label flex items-center gap-1.5">
                <KeyRound size={13} /> Workspace ID
              </p>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 min-w-0 truncate text-xs rounded-md px-2.5 py-2 select-all"
                  style={{ background: "var(--surface-muted)", color: "var(--text)" }}
                >
                  {hotelId ?? "—"}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm shrink-0"
                  onClick={copyWorkspaceId}
                  aria-label="Copy workspace ID"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <p className="text-xs muted mt-2 leading-relaxed">
                This ID is the key to your workspace. Keep it private: anyone who has it can open
                this hotel's data.
              </p>
            </div>
          </Card>
          </div>
        </div>
      )}

      {/* ---------- ACTIVITY ---------- */}
      {tab === "activity" && (
        <div className="space-y-5">
          <div className="filter-bar">
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="search-wrap flex-1">
                <Search size={16} />
                <input
                  className="input"
                  aria-label="Search activity"
                  placeholder="Search action or detail…"
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                />
              </div>
              <select
                className="select lg:w-56"
                aria-label="Activity type"
                value={auditEntity}
                onChange={(e) => setAuditEntity(e.target.value as "All" | AuditEntity)}
              >
                {ENTITY_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-3 text-sm muted">
              Showing <strong style={{ color: "var(--text)" }}>{visibleAudit.length}</strong> of the
              latest {audit.length} entries. Activity is append-only and cannot be edited.
            </p>
          </div>

          <Card bodyClassName="">
            <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Type</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLoading ? (
                    <TableSkeleton rows={6} columns={4} />
                  ) : visibleAudit.length ? (
                    visibleAudit.map((r) => (
                      <tr key={r.id}>
                        <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                          {dateTime(toDateSafe(r.at))}
                        </td>
                        <td className="font-medium" style={{ color: "var(--text)" }}>
                          {r.action}
                          {r.userEmail && <span className="block text-xs muted font-normal">{r.userEmail}</span>}
                        </td>
                        <td>
                          <span className="badge badge-neutral badge-plain">{r.entity}</span>
                        </td>
                        <td className="muted">{r.details || "—"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState
                          icon={<Activity size={24} />}
                          title="No activity recorded"
                          description={
                            audit.length
                              ? "Nothing matches your filters."
                              : "Bookings, sales, transfers and settings changes are logged here."
                          }
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === "hotel" && (
        <p className="text-xs muted flex items-center gap-1.5">
          <Building2 size={13} /> Currency changes apply everywhere immediately — existing amounts
          are not converted.
        </p>
      )}
    </div>
  );
}

/**
 * The link a hotel shares with guests. It carries the public id, never the
 * workspace id above it, so sharing it opens the concierge and nothing else.
 */
/**
 * Whether guests can find this hotel in the network AI Concierge, and what
 * they are told about it (DECISIONS D24). The concierge reports anything
 * left blank as "not recorded" — it never fills a gap with a guess.
 */
function ConciergeListingCard({ hotelId, profile }: { hotelId: string; profile: HotelProfile }) {
  const toast = useToast();
  const [draft, setDraft] = useState<HotelListing>(() => toHotelListing(profile as unknown as Record<string, unknown>));
  const [amenities, setAmenities] = useState(() => profile.amenities.join(", "));
  const [saving, setSaving] = useState(false);
  const hasPublicId = Boolean(profile.publicId);
  const set = (patch: Partial<HotelListing>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    const result = await saveConciergeListing(hotelId, { ...draft, amenities: parseAmenityList(amenities) }, hasPublicId);
    setSaving(false);
    if (result.ok) toast.success(draft.listed ? "Listed in the AI Concierge" : "Listing saved");
    else toast.error(result.error);
  };

  return (
    <Card title="AI Concierge listing">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex items-start gap-2.5 text-sm" style={{ color: "var(--text)" }}>
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.listed}
            disabled={!hasPublicId}
            onChange={(e) => set({ listed: e.target.checked })}
          />
          <span>
            <span className="font-semibold inline-flex items-center gap-1.5">
              <Globe size={14} /> Guests can find and book this hotel
            </span>
            <span className="block text-xs muted">
              {hasPublicId ? "Include your live rooms in K Hotels AI Concierge searches." : "Create your concierge link above first."}
            </span>
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Region">
            <input className="input" placeholder="e.g. Western" value={draft.region} onChange={(e) => set({ region: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Country">
            <input className="input" placeholder="e.g. Uganda" value={draft.country} onChange={(e) => set({ country: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Check-in from">
            <input className="input" placeholder="14:00" value={draft.checkInTime} onChange={(e) => set({ checkInTime: e.target.value })} maxLength={20} />
          </Field>
          <Field label="Check-out by">
            <input className="input" placeholder="10:00" value={draft.checkOutTime} onChange={(e) => set({ checkOutTime: e.target.value })} maxLength={20} />
          </Field>
        </div>
        <Field label="Short description">
          <textarea className="input" rows={2} maxLength={500} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Amenities (comma separated)">
          <textarea className="input" rows={2} placeholder="Free Wi-Fi, Breakfast included, Free parking" value={amenities} onChange={(e) => setAmenities(e.target.value)} />
        </Field>
        <Field label="Policies">
          <textarea className="input" rows={3} maxLength={1000} placeholder="Payment, cancellation, children, pets…" value={draft.policies} onChange={(e) => set({ policies: e.target.value })} />
        </Field>
        <p className="text-xs muted">Guests are told only what you write here. Anything left blank, the concierge says it can't confirm.</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? "Saving…" : "Save listing"}
        </button>
      </form>
    </Card>
  );
}

function ConciergeLinkCard({
  hotelId,
  hotelName,
  publicId,
  loading,
}: {
  hotelId: string | null;
  hotelName: string;
  publicId: string;
  loading: boolean;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  // The app routes with HashRouter, so the path lives after "#".
  const link = publicId ? `${window.location.origin}/#/c/${publicId}` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Concierge link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy automatically. Select the link and copy it instead.");
    }
  };

  const create = async () => {
    if (!hotelId) return;
    setCreating(true);
    const result = await publishConciergeLink(hotelId, hotelName || "hotel");
    setCreating(false);
    if (result.ok) toast.success("Concierge link created");
    else toast.error(result.error);
  };

  return (
    <Card title="Guest AI Concierge">
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        Your hotel's own concierge link: the AI Concierge limited to your hotel. Share it on your website,
        WhatsApp or social pages. Guests see live prices and availability and book around the clock.
      </p>
      <div className="mt-4">
        {loading ? (
          <div className="skeleton" style={{ height: 36 }} />
        ) : publicId ? (
          <>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 min-w-0 truncate text-xs rounded-md px-2.5 py-2 select-all"
                style={{ background: "var(--surface-muted)", color: "var(--text)" }}
              >
                {link}
              </code>
              <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={copy} aria-label="Copy concierge link">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <a className="btn btn-primary btn-sm shrink-0" href={link} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open
              </a>
            </div>
            <p className="text-xs muted mt-2 leading-relaxed">
              Safe to share: the link only opens your guest concierge, never this workspace.
            </p>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={create} disabled={creating || !hotelId}>
            <Sparkles size={14} /> {creating ? "Creating…" : "Create concierge link"}
          </button>
        )}
      </div>
    </Card>
  );
}
