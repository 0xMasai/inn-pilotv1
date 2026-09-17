/**
 * The owner's financial command center.
 *
 * Eight KPIs answer "how did we do today?", and everything below answers
 * "why?" — where the money came from, what went out, and what needs
 * attention. Every figure comes from lib/metrics, so this page can never
 * disagree with Reports.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BedDouble,
  Beer,
  CircleParking,
  DoorOpen,
  PackageX,
  Receipt,
  Scale,
  TrendingUp,
  Utensils,
  Wallet,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useWorkspace } from "../workspace/workspaceContext";
import { useHotelData } from "../lib/useHotelData";
import { useHotelProfile } from "../lib/hotelProfile";
import {
  computeMetrics,
  dailySeries,
  departmentBreakdown,
  getRange,
  previousRange,
  recentTransactions,
  stockStatusOf,
  type DatePreset,
  type TransactionKind,
} from "../lib/metrics";
import { money, moneyCompact, num, percent, plural, timeShort } from "../lib/format";
import {
  Card,
  EmptyState,
  PageHeader,
  SegmentedControl,
  ShareBar,
  StatCard,
  StatGrid,
} from "../components/ui";

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "lastMonth", label: "Last Month" },
  { key: "all", label: "All Time" },
];

const DEPT_COLOR: Record<string, string> = {
  Accommodation: "#0e93a3",
  Restaurant: "#ea580c",
  Bar: "#7c3aed",
  Parking: "#2563eb",
};

const KIND_STYLE: Record<TransactionKind, { color: string; icon: typeof BedDouble }> = {
  Accommodation: { color: "#0e93a3", icon: BedDouble },
  Restaurant: { color: "#ea580c", icon: Utensils },
  Bar: { color: "#7c3aed", icon: Beer },
  Parking: { color: "#2563eb", icon: CircleParking },
  Expense: { color: "#dc2626", icon: Receipt },
};

/** Percent change between two periods; null when there's no basis to compare. */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function Dashboard() {
  const { hotelId } = useWorkspace();
  const { data, loading, error } = useHotelData(hotelId);
  const { profile } = useHotelProfile(hotelId);
  const [preset, setPreset] = useState<DatePreset>("today");

  const currency = profile.currency;
  const range = useMemo(() => getRange(preset), [preset]);
  const metrics = useMemo(() => computeMetrics(data, range), [data, range]);
  const prior = useMemo(
    () => computeMetrics(data, previousRange(range)),
    [data, range]
  );
  const trend = useMemo(() => dailySeries(data, range), [data, range]);
  const departments = useMemo(() => departmentBreakdown(metrics), [metrics]);
  const transactions = useMemo(() => recentTransactions(data, range, 8), [data, range]);

  /** Products at or below their reorder level, worst first. */
  const lowStock = useMemo(() => {
    return data.barProducts
      .filter((p) => !p.archived)
      .map((p) => ({
        name: p.name ?? "Unnamed product",
        unit: p.unit ?? "",
        stock: Number(p.barStock) || 0,
        reorderLevel: Number(p.reorderLevel) || 0,
        status: stockStatusOf(Number(p.barStock) || 0, Number(p.reorderLevel) || 0),
      }))
      .filter((p) => p.status !== "Good")
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 6);
  }, [data.barProducts]);

  const periodLabel = range.label.toLowerCase();
  const lowStockTotal = metrics.stock.lowCount + metrics.stock.criticalCount;

  return (
    <div className="space-y-6">
      <PageHeader
        title={profile.name ? `${profile.name}` : "Dashboard"}
        subtitle={`Financial performance · ${periodLabel}`}
        actions={
          <SegmentedControl
            label="Reporting period"
            value={preset}
            options={PRESETS}
            onChange={setPreset}
          />
        }
      />

      {error && (
        <div
          className="text-sm rounded-lg px-4 py-3"
          style={{
            background: "var(--warning-soft)",
            color: "var(--warning-text)",
            border: "1px solid var(--warning-border)",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      {/* PRIMARY KPIs */}
      <StatGrid>
        <StatCard
          index={0}
          loading={loading}
          label={`Total Revenue ${range.label}`}
          value={money(metrics.totalRevenue, currency)}
          icon={<TrendingUp size={19} />}
          tone="success"
          delta={delta(metrics.totalRevenue, prior.totalRevenue)}
          hint="All departments"
        />
        <StatCard
          index={1}
          loading={loading}
          label={`Net Profit ${range.label}`}
          value={money(metrics.netProfit, currency)}
          icon={<Scale size={19} />}
          tone={metrics.netProfit >= 0 ? "success" : "danger"}
          delta={delta(metrics.netProfit, prior.netProfit)}
          hint="Revenue less recorded expenses"
        />
        <StatCard
          index={2}
          loading={loading}
          label={`Total Expenses ${range.label}`}
          value={money(metrics.totalExpenses, currency)}
          icon={<Receipt size={19} />}
          tone="warning"
          delta={delta(metrics.totalExpenses, prior.totalExpenses)}
          invertDelta
          hint={plural(data.expenses.length, "entry", "entries") + " on record"}
        />
        <StatCard
          index={3}
          loading={loading}
          label="Occupancy Rate"
          value={percent(metrics.occupancy.rate)}
          icon={<DoorOpen size={19} />}
          tone="purple"
          hint={
            metrics.occupancy.rate === null
              ? "Register rooms to track occupancy"
              : `${metrics.occupancy.occupied} of ${metrics.occupancy.totalRooms} rooms occupied`
          }
        />
      </StatGrid>

      {/* DEPARTMENT KPIs */}
      <StatGrid>
        <StatCard
          index={4}
          loading={loading}
          label="Restaurant Sales"
          value={money(metrics.restaurantRevenue, currency)}
          icon={<Utensils size={19} />}
          tone="orange"
          hint={plural(metrics.ordersCount, "order")}
        />
        <StatCard
          index={5}
          loading={loading}
          label="Bar Sales"
          value={money(metrics.barRevenue, currency)}
          icon={<Beer size={19} />}
          tone="purple"
          hint={`${plural(metrics.barSalesCount, "sale")} · ${money(metrics.barGrossProfit, currency)} gross profit`}
        />
        <StatCard
          index={6}
          loading={loading}
          label="Parking Revenue"
          value={money(metrics.parkingRevenue, currency)}
          icon={<CircleParking size={19} />}
          tone="primary"
          hint={plural(metrics.parkingCount, "vehicle")}
        />
        <StatCard
          index={7}
          loading={loading}
          label="Low Stock Items"
          value={num(lowStockTotal)}
          icon={<PackageX size={19} />}
          tone={metrics.stock.criticalCount > 0 ? "danger" : lowStockTotal > 0 ? "warning" : "success"}
          hint={
            metrics.stock.criticalCount > 0
              ? `${metrics.stock.criticalCount} critical · stock worth ${moneyCompact(metrics.stock.value, currency)}`
              : `Bar stock worth ${moneyCompact(metrics.stock.value, currency)}`
          }
        />
      </StatGrid>

      {/* TREND + BREAKDOWN */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card
          className="lg:col-span-2"
          title="Revenue vs Expenses"
          action={<span className="text-xs muted">{range.label}</span>}
        >
          {trend.length === 0 ? (
            <EmptyState
              icon={<TrendingUp size={24} />}
              title="Nothing recorded yet"
              description="Once bookings, sales and expenses are entered, the trend appears here."
            />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0e93a3" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#0e93a3" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="expFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#dc2626" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#dc2626" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f4" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "#e5e8ee" }} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={70}
                  tickFormatter={(v) => moneyCompact(v, "").trim()}
                />
                <Tooltip
                  formatter={(v: unknown, name: unknown) => [money(Number(v), currency), String(name)]}
                />
                <Area
                  type="monotone"
                  name="Revenue"
                  dataKey="revenue"
                  stroke="#0e93a3"
                  strokeWidth={2.5}
                  fill="url(#revFill)"
                />
                <Area
                  type="monotone"
                  name="Expenses"
                  dataKey="expenses"
                  stroke="#dc2626"
                  strokeWidth={2}
                  fill="url(#expFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Revenue by Department">
          {metrics.totalRevenue === 0 ? (
            <EmptyState
              icon={<Scale size={24} />}
              title="No revenue yet"
              description={`Nothing was recorded ${periodLabel}.`}
            />
          ) : (
            <div className="space-y-4">
              {departments.map((d) => (
                <ShareBar
                  key={d.name}
                  name={d.name}
                  amount={d.revenue}
                  share={d.share}
                  color={DEPT_COLOR[d.name] ?? "var(--primary)"}
                  currency={currency}
                />
              ))}
              <div className="kv kv-total">
                <span className="kv-label">Total revenue</span>
                <span className="kv-value">{money(metrics.totalRevenue, currency)}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* TRANSACTIONS + ALERTS + SUMMARY */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card
          className="lg:col-span-2"
          title="Recent Transactions"
          action={
            <Link
              to="/dashboard/reports"
              className="text-xs font-semibold inline-flex items-center gap-1"
              style={{ color: "var(--primary)" }}
            >
              All reports <ArrowRight size={13} />
            </Link>
          }
          bodyClassName=""
        >
          {transactions.length === 0 ? (
            <EmptyState
              icon={<Receipt size={24} />}
              title="No transactions yet"
              description={`Nothing was recorded ${periodLabel}. Sales and expenses appear here as they happen.`}
            />
          ) : (
            <ul>
              {transactions.map((t, i) => {
                const style = KIND_STYLE[t.kind];
                const Icon = style.icon;
                const isExpense = t.amount < 0;
                return (
                  <li
                    key={`${t.kind}-${i}-${t.at?.getTime() ?? i}`}
                    className="flex items-center gap-3 px-5 py-3"
                    style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
                  >
                    <span
                      className="w-9 h-9 rounded-lg flex-none flex items-center justify-center"
                      style={{ background: `${style.color}14`, color: style.color }}
                      aria-hidden
                    >
                      <Icon size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-sm font-medium truncate"
                        style={{ color: "var(--text)" }}
                      >
                        {t.description}
                      </p>
                      <p className="text-xs muted">
                        {t.kind} · {timeShort(t.at)}
                      </p>
                    </div>
                    <span
                      className="text-sm font-semibold num"
                      style={{ color: isExpense ? "var(--danger-text)" : "var(--success-text)" }}
                    >
                      {isExpense ? "−" : "+"}
                      {money(Math.abs(t.amount), currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card
            title="Low Stock Alerts"
            action={
              <Link
                to="/dashboard/bar/products"
                className="text-xs font-semibold inline-flex items-center gap-1"
                style={{ color: "var(--primary)" }}
              >
                Manage <ArrowRight size={13} />
              </Link>
            }
          >
            {lowStock.length === 0 ? (
              <EmptyState
                icon={<PackageX size={22} />}
                title="Stock is healthy"
                description="No bar product is at or below its reorder level."
              />
            ) : (
              <ul className="space-y-2.5">
                {lowStock.map((p) => (
                  <li key={p.name} className="flex items-center gap-3">
                    <span
                      className="w-1.5 h-8 rounded-full flex-none"
                      style={{
                        background:
                          p.status === "Critical" ? "var(--danger)" : "var(--warning)",
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                        {p.name}
                      </p>
                      <p className="text-xs muted">
                        {p.stock} left · reorder at {p.reorderLevel}
                      </p>
                    </div>
                    <span className={`badge ${p.status === "Critical" ? "badge-danger" : "badge-warning"}`}>
                      {p.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Today's Operations`}>
            <div>
              <div className="kv">
                <span className="kv-label">Rooms occupied</span>
                <span className="kv-value">
                  {metrics.occupancy.occupied} / {metrics.occupancy.totalRooms || "—"}
                </span>
              </div>
              <div className="kv">
                <span className="kv-label">Rooms available</span>
                <span className="kv-value">{metrics.occupancy.available}</span>
              </div>
              <div className="kv">
                <span className="kv-label">Bookings {periodLabel}</span>
                <span className="kv-value">{metrics.bookingsCount}</span>
              </div>
              <div className="kv">
                <span className="kv-label">Restaurant orders</span>
                <span className="kv-value">{metrics.ordersCount}</span>
              </div>
              <div className="kv">
                <span className="kv-label">Bar sales</span>
                <span className="kv-value">{metrics.barSalesCount}</span>
              </div>
              <div className="kv">
                <span className="kv-label">Vehicles parked</span>
                <span className="kv-value">{metrics.parkingCount}</span>
              </div>
              {metrics.pendingPayments.count > 0 && (
                <div className="kv">
                  <span className="kv-label">Unpaid bookings</span>
                  <span className="kv-value" style={{ color: "var(--warning-text)" }}>
                    {money(metrics.pendingPayments.amount, currency)}
                  </span>
                </div>
              )}
            </div>
          </Card>

          <Card title="Jump to">
            <div className="grid grid-cols-2 gap-2">
              <Link to="/dashboard/bar/sales" className="btn btn-secondary btn-sm">
                <Beer size={14} /> New bar sale
              </Link>
              <Link to="/dashboard/parking" className="btn btn-secondary btn-sm">
                <CircleParking size={14} /> Park vehicle
              </Link>
              <Link to="/dashboard/expenses" className="btn btn-secondary btn-sm">
                <Wallet size={14} /> Add expense
              </Link>
              <Link to="/dashboard/accommodation" className="btn btn-secondary btn-sm">
                <BedDouble size={14} /> New booking
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
