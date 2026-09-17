/**
 * Parking — vehicles on the lot and the income they generate.
 *
 * A record opens on arrival and closes on release. Metered rates are
 * priced at release from the actual dwell time, so the amount shown for a
 * parked car is an estimate and the amount stored is what was charged.
 */
import { useEffect, useMemo, useState } from "react";
import { limit, onSnapshot, orderBy, query } from "firebase/firestore";
import {
  Banknote,
  Car,
  CircleParking,
  LogOut,
  Plus,
  Search,
  Timer,
} from "lucide-react";

import { useWorkspace } from "../workspace/workspaceContext";
import { useHotelProfile } from "../lib/hotelProfile";
import { COLLECTIONS, PAYMENT_METHODS, type PaymentMethod } from "../lib/collections";
import { hotelCollection } from "../lib/hotelScope";
import {
  checkInVehicle,
  computeFee,
  formatDuration,
  RATE_TYPES,
  releaseVehicle,
  toParkingEntry,
  VEHICLE_TYPES,
  type ParkingEntry,
  type RateType,
} from "../lib/parking";
import { getRange, inRange, parkingDate, toDateSafe } from "../lib/metrics";
import { dateTime, money, num, plural } from "../lib/format";
import {
  Card,
  EmptyState,
  Field,
  FormError,
  Modal,
  PageHeader,
  SegmentedControl,
  StatCard,
  StatGrid,
  TableSkeleton,
  useToast,
} from "../components/ui";

const HISTORY_LIMIT = 300;

const BLANK = {
  vehiclePlate: "",
  vehicleType: "Car" as string,
  driverName: "",
  guestName: "",
  slot: "",
  rateType: "Flat" as RateType,
  rate: 0,
  note: "",
};

type Tab = "parked" | "history";

export default function Parking() {
  const { hotelId } = useWorkspace();
  const { profile } = useHotelProfile(hotelId);
  const toast = useToast();
  const currency = profile.currency;

  const [entries, setEntries] = useState<ParkingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("parked");
  const [search, setSearch] = useState("");

  // Re-render once a minute so dwell times and estimated fees stay honest
  // without the user having to refresh the page.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const [checkInOpen, setCheckInOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [releasing, setReleasing] = useState<ParkingEntry | null>(null);
  const [releaseMethod, setReleaseMethod] = useState<PaymentMethod>("Cash");
  const [releaseAmount, setReleaseAmount] = useState("");
  const [releaseError, setReleaseError] = useState("");
  const [releaseBusy, setReleaseBusy] = useState(false);

  useEffect(() => {
    if (!hotelId) return;
    setLoading(true);
    const unsub = onSnapshot(
      query(
        hotelCollection(hotelId, COLLECTIONS.PARKING),
        orderBy("createdAt", "desc"),
        limit(HISTORY_LIMIT)
      ),
      (snap) => {
        setEntries(snap.docs.map((d) => toParkingEntry(d.id, d.data() as Record<string, unknown>)));
        setLoading(false);
      },
      (err) => {
        console.error("Failed to read parking records:", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [hotelId]);

  const parked = useMemo(() => entries.filter((e) => e.status === "Parked"), [entries]);
  const released = useMemo(() => entries.filter((e) => e.status === "Released"), [entries]);

  const stats = useMemo(() => {
    const today = getRange("today");
    const todayReleased = entries.filter(
      (e) => e.status === "Released" && inRange(parkingDate(e), today)
    );
    const revenue = todayReleased.reduce((sum, e) => sum + e.amount, 0);
    // What is currently accruing on the lot but not yet collected.
    const onLot = parked.reduce((sum, e) => sum + computeFee(e, now), 0);
    return {
      revenue,
      releasedToday: todayReleased.length,
      parked: parked.length,
      onLot,
    };
  }, [entries, parked, now]);

  const visible = useMemo(() => {
    const source = tab === "parked" ? parked : released;
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (e) =>
        e.vehiclePlate.toLowerCase().includes(q) ||
        (e.driverName ?? "").toLowerCase().includes(q) ||
        (e.guestName ?? "").toLowerCase().includes(q)
    );
  }, [tab, parked, released, search]);

  const submitCheckIn = async () => {
    if (!hotelId) return setFormError("No workspace is open. Reload the page and try again.");
    setSaving(true);
    setFormError("");
    const result = await checkInVehicle(
      hotelId,
      {
        vehiclePlate: form.vehiclePlate,
        vehicleType: form.vehicleType,
        driverName: form.driverName,
        guestName: form.guestName,
        slot: form.slot,
        rateType: form.rateType,
        rate: form.rate,
        note: form.note,
      },
      entries
    );
    setSaving(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    toast.success(`${form.vehiclePlate.toUpperCase()} checked in`);
    setForm(BLANK);
    setCheckInOpen(false);
    setTab("parked");
  };

  const openRelease = (entry: ParkingEntry) => {
    setReleasing(entry);
    setReleaseMethod(entry.paymentMethod ?? "Cash");
    setReleaseAmount(String(computeFee(entry, new Date())));
    setReleaseError("");
  };

  const submitRelease = async () => {
    if (!releasing || !hotelId) return;
    const amount = Number(releaseAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return setReleaseError("Enter a valid amount.");
    }
    setReleaseBusy(true);
    setReleaseError("");
    const result = await releaseVehicle(hotelId, releasing, releaseMethod, amount);
    setReleaseBusy(false);

    if (!result.ok) {
      setReleaseError(result.error);
      return;
    }
    toast.success(`${releasing.vehiclePlate} released · ${money(result.data.amount, currency)}`);
    setReleasing(null);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parking"
        subtitle="Vehicles on the lot and the income they generate"
        actions={
          <button className="btn btn-primary" onClick={() => setCheckInOpen(true)}>
            <Plus size={16} /> Check in vehicle
          </button>
        }
      />

      <StatGrid>
        <StatCard
          index={0}
          loading={loading}
          label="Parking Revenue Today"
          value={money(stats.revenue, currency)}
          icon={<Banknote size={19} />}
          tone="success"
          hint={`${plural(stats.releasedToday, "vehicle")} released`}
        />
        <StatCard
          index={1}
          loading={loading}
          label="Currently Parked"
          value={num(stats.parked)}
          icon={<CircleParking size={19} />}
          tone="primary"
          hint="On the lot right now"
        />
        <StatCard
          index={2}
          loading={loading}
          label="Accruing on Lot"
          value={money(stats.onLot, currency)}
          icon={<Timer size={19} />}
          tone="warning"
          hint="Estimated, not yet collected"
        />
        <StatCard
          index={3}
          loading={loading}
          label="Records"
          value={num(entries.length)}
          icon={<Car size={19} />}
          tone="purple"
          hint="Most recent 300"
        />
      </StatGrid>

      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <SegmentedControl
            label="Parking view"
            value={tab}
            onChange={setTab}
            options={[
              { key: "parked", label: `On the lot (${parked.length})` },
              { key: "history", label: "History" },
            ]}
          />
          <div className="search-wrap flex-1">
            <Search size={16} />
            <input
              className="input"
              aria-label="Search vehicles"
              placeholder="Search plate, driver or guest…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <Card bodyClassName="">
        <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Plate</th>
                <th>Type</th>
                <th>Driver / Guest</th>
                <th>Slot</th>
                <th>Checked in</th>
                <th>Duration</th>
                <th>Rate</th>
                <th className="num">{tab === "parked" ? "Running fee" : "Charged"}</th>
                {tab === "history" && <th>Payment</th>}
                {tab === "parked" && <th className="text-center">Action</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={5} columns={9} />
              ) : visible.length ? (
                visible.map((entry) => (
                  <tr key={entry.id}>
                    <td className="font-semibold" style={{ color: "var(--text)" }}>
                      {entry.vehiclePlate}
                    </td>
                    <td>
                      <span className="badge badge-neutral badge-plain">{entry.vehicleType}</span>
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>
                      {entry.driverName || entry.guestName || "—"}
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>{entry.slot || "—"}</td>
                    <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {dateTime(toDateSafe(entry.checkIn))}
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>
                      {formatDuration(entry, now)}
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>
                      {entry.rateType === "Flat"
                        ? "Flat"
                        : `${money(entry.rate, currency)}/${entry.rateType === "Hourly" ? "hr" : "day"}`}
                    </td>
                    <td className="num font-semibold">
                      {entry.status === "Parked"
                        ? money(computeFee(entry, now), currency)
                        : money(entry.amount, currency)}
                    </td>
                    {tab === "history" && (
                      <td style={{ color: "var(--text-secondary)" }}>
                        {entry.paymentMethod ?? "—"}
                      </td>
                    )}
                    {tab === "parked" && (
                      <td className="text-center">
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() => openRelease(entry)}
                        >
                          <LogOut size={14} /> Release
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={10}>
                    <EmptyState
                      icon={<CircleParking size={24} />}
                      title={tab === "parked" ? "No vehicles on the lot" : "No parking history"}
                      description={
                        search
                          ? "No vehicle matches your search."
                          : tab === "parked"
                            ? "Check a vehicle in and it will appear here until it's released."
                            : "Released vehicles and the fees collected show up here."
                      }
                      action={
                        !search && tab === "parked" ? (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => setCheckInOpen(true)}
                          >
                            <Plus size={15} /> Check in vehicle
                          </button>
                        ) : undefined
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* CHECK IN */}
      <Modal
        open={checkInOpen}
        onClose={() => !saving && setCheckInOpen(false)}
        title="Check in vehicle"
        description="Record an arrival. The fee is settled when the vehicle is released."
        width="md"
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setCheckInOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submitCheckIn} disabled={saving}>
              {saving ? "Saving…" : "Check in"}
            </button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submitCheckIn();
          }}
        >
          <FormError message={formError} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Number plate" required>
              <input
                className="input"
                value={form.vehiclePlate}
                onChange={(e) => setForm((f) => ({ ...f, vehiclePlate: e.target.value }))}
                placeholder="UAX 123B"
                autoFocus
                style={{ textTransform: "uppercase" }}
              />
            </Field>

            <Field label="Vehicle type">
              <select
                className="select"
                value={form.vehicleType}
                onChange={(e) => setForm((f) => ({ ...f, vehicleType: e.target.value }))}
              >
                {VEHICLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Driver name">
              <input
                className="input"
                value={form.driverName}
                onChange={(e) => setForm((f) => ({ ...f, driverName: e.target.value }))}
                placeholder="Optional"
              />
            </Field>

            <Field label="Guest" hint="If this vehicle belongs to a staying guest.">
              <input
                className="input"
                value={form.guestName}
                onChange={(e) => setForm((f) => ({ ...f, guestName: e.target.value }))}
                placeholder="Optional"
              />
            </Field>

            <Field label="Rate type">
              <select
                className="select"
                value={form.rateType}
                onChange={(e) => setForm((f) => ({ ...f, rateType: e.target.value as RateType }))}
              >
                {RATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={`Rate (${currency})`}
              hint={
                form.rateType === "Flat"
                  ? "Charged once, regardless of time."
                  : `Charged per ${form.rateType === "Hourly" ? "hour" : "day"}, rounded up.`
              }
            >
              <input
                type="number"
                min={0}
                className="input"
                value={form.rate || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, rate: Math.max(0, Number(e.target.value) || 0) }))
                }
                placeholder="0"
              />
            </Field>

            <Field label="Slot">
              <input
                className="input"
                value={form.slot}
                onChange={(e) => setForm((f) => ({ ...f, slot: e.target.value }))}
                placeholder="e.g. A12"
              />
            </Field>

            <Field label="Note">
              <input
                className="input"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="Optional"
              />
            </Field>
          </div>
        </form>
      </Modal>

      {/* RELEASE */}
      <Modal
        open={!!releasing}
        onClose={() => !releaseBusy && setReleasing(null)}
        title={releasing ? `Release ${releasing.vehiclePlate}` : "Release vehicle"}
        description="Confirm the amount collected. This closes the record and books the revenue."
        width="sm"
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setReleasing(null)}
              disabled={releaseBusy}
            >
              Cancel
            </button>
            <button className="btn btn-success" onClick={submitRelease} disabled={releaseBusy}>
              {releaseBusy ? "Releasing…" : "Release & collect"}
            </button>
          </>
        }
      >
        {releasing && (
          <div className="space-y-4">
            <div>
              <div className="kv">
                <span className="kv-label">Parked for</span>
                <span className="kv-value">{formatDuration(releasing, now)}</span>
              </div>
              <div className="kv">
                <span className="kv-label">Rate</span>
                <span className="kv-value">
                  {releasing.rateType === "Flat"
                    ? `Flat ${money(releasing.rate, currency)}`
                    : `${money(releasing.rate, currency)} per ${releasing.rateType === "Hourly" ? "hour" : "day"}`}
                </span>
              </div>
              <div className="kv kv-total">
                <span className="kv-label">Calculated fee</span>
                <span className="kv-value">{money(computeFee(releasing, now), currency)}</span>
              </div>
            </div>

            <Field
              label={`Amount to collect (${currency})`}
              required
              hint="Adjust for a discount or a rounded cash figure."
            >
              <input
                type="number"
                min={0}
                className="input"
                value={releaseAmount}
                onChange={(e) => setReleaseAmount(e.target.value)}
              />
            </Field>

            <Field label="Payment method">
              <select
                className="select"
                value={releaseMethod}
                onChange={(e) => setReleaseMethod(e.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <FormError message={releaseError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
