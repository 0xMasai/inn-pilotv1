/**
 * Reporting.
 *
 * Every figure comes from lib/metrics — the same functions that power the
 * Dashboard — so a report can never disagree with the screen the owner
 * was just looking at. PDF/CSV export and print reuse lib/exportUtils.
 */
import { useMemo, useState } from "react";
import {
  BedDouble,
  Beer,
  CircleParking,
  Download,
  FileBarChart,
  FileSpreadsheet,
  Printer,
  Receipt,
  Scale,
  Utensils,
} from "lucide-react";

import { useWorkspace } from "./workspace/workspaceContext";
import { useHotelData } from "./lib/useHotelData";
import { useHotelProfile } from "./lib/hotelProfile";
import {
  barSaleDate,
  bestSellingProducts,
  bookingDate,
  bookingStatusOf,
  computeMetrics,
  customRange,
  departmentBreakdown,
  expenseDate,
  getRange,
  inRange,
  isRevenueOrder,
  orderDate,
  parkingDate,
  previousRange,
  toDateSafe,
  type DateRange,
} from "./lib/metrics";
import { dateTime, money, percent } from "./lib/format";
import {
  Card,
  EmptyState,
  PageHeader,
  SegmentedControl,
  StatCard,
  StatGrid,
  useToast,
} from "./components/ui";

type ReportKey = "financial" | "accommodation" | "restaurant" | "bar" | "parking" | "expenses";
type PeriodKey = "daily" | "weekly" | "monthly" | "lastMonth" | "custom";

const REPORTS: { key: ReportKey; label: string; description: string; icon: typeof Scale }[] = [
  { key: "financial", label: "Financial Summary", description: "Revenue, expenses and net profit", icon: Scale },
  { key: "accommodation", label: "Accommodation", description: "Bookings and occupancy", icon: BedDouble },
  { key: "restaurant", label: "Restaurant", description: "Orders and dining revenue", icon: Utensils },
  { key: "bar", label: "Bar", description: "Sales, margin and best sellers", icon: Beer },
  { key: "parking", label: "Parking", description: "Vehicles and parking income", icon: CircleParking },
  { key: "expenses", label: "Expenses", description: "Operational spending", icon: Receipt },
];

/** Daily / weekly / monthly, as the brief specifies, plus a custom range. */
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "lastMonth", label: "Last Month" },
  { key: "custom", label: "Custom" },
];

interface BuiltReport {
  title: string;
  kpis: { label: string; value: string }[];
  columns: string[];
  rows: (string | number)[][];
}

export default function Reports() {
  const { hotelId } = useWorkspace();
  const { data, loading } = useHotelData(hotelId);
  const { profile } = useHotelProfile(hotelId);
  const toast = useToast();
  const currency = profile.currency;

  const [report, setReport] = useState<ReportKey>("financial");
  const [period, setPeriod] = useState<PeriodKey>("daily");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const range: DateRange = useMemo(() => {
    if (period === "custom" && customStart && customEnd) {
      const s = new Date(customStart);
      const e = new Date(customEnd);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && s <= e) return customRange(s, e);
    }
    switch (period) {
      case "weekly":
        return getRange("week");
      case "monthly":
        return getRange("month");
      case "lastMonth":
        return getRange("lastMonth");
      // A custom range with nothing picked yet behaves as today.
      default:
        return getRange("today");
    }
  }, [period, customStart, customEnd]);

  const metrics = useMemo(() => computeMetrics(data, range), [data, range]);
  const prior = useMemo(() => computeMetrics(data, previousRange(range)), [data, range]);
  const departments = useMemo(() => departmentBreakdown(metrics), [metrics]);

  const built: BuiltReport = useMemo(() => {
    const money2 = (n: number) => money(n, currency);

    switch (report) {
      case "accommodation": {
        const rows = data.bookings
          .filter((b) => inRange(bookingDate(b), range))
          .sort((a, b) => (bookingDate(a)?.getTime() ?? 0) - (bookingDate(b)?.getTime() ?? 0))
          .map((b) => [
            String(b.roomNumber ?? "—"),
            b.guestName ?? "—",
            b.roomType ?? "—",
            dateTime(toDateSafe(b.checkIn)),
            dateTime(toDateSafe(b.checkOut)),
            money2(Number(b.pricePaid) || 0),
            b.paymentStatus ?? "—",
            bookingStatusOf(b),
          ]);
        return {
          title: "Accommodation Report",
          kpis: [
            { label: "Bookings", value: String(metrics.bookingsCount) },
            { label: "Revenue", value: money2(metrics.accommodationRevenue) },
            {
              label: "Occupancy",
              value:
                metrics.occupancy.rate === null
                  ? "No rooms registered"
                  : `${metrics.occupancy.rate}% (${metrics.occupancy.occupied}/${metrics.occupancy.totalRooms})`,
            },
            { label: "Unpaid", value: money2(metrics.pendingPayments.amount) },
          ],
          columns: ["Room", "Guest", "Type", "Check-in", "Check-out", "Amount", "Payment", "Status"],
          rows,
        };
      }

      case "restaurant": {
        const inPeriod = data.orders.filter((o) => inRange(orderDate(o), range));
        const revenueOrders = inPeriod.filter(isRevenueOrder);
        const avg = revenueOrders.length ? metrics.restaurantRevenue / revenueOrders.length : 0;
        return {
          title: "Restaurant Sales Report",
          kpis: [
            { label: "Sales", value: money2(metrics.restaurantRevenue) },
            { label: "Orders", value: String(metrics.ordersCount) },
            { label: "Average Order", value: money2(avg) },
          ],
          columns: ["Client", "Order", "Category", "Price", "Payment", "Status", "Date"],
          rows: inPeriod
            .sort((a, b) => (orderDate(a)?.getTime() ?? 0) - (orderDate(b)?.getTime() ?? 0))
            .map((o) => [
              o.clientName ?? "—",
              o.orderDetails ?? "—",
              o.category ?? "—",
              money2(Number(o.price) || 0),
              o.paymentMethod ?? "—",
              o.status ?? "Paid",
              dateTime(orderDate(o)),
            ]),
        };
      }

      case "bar": {
        const inPeriod = data.barSales.filter((s) => inRange(barSaleDate(s), range));
        const best = bestSellingProducts(data.barSales, range, 10);
        return {
          title: "Bar Report",
          kpis: [
            { label: "Sales", value: money2(metrics.barRevenue) },
            { label: "Cost of Goods", value: money2(metrics.barCost) },
            { label: "Gross Profit", value: money2(metrics.barGrossProfit) },
            {
              label: "Margin",
              value:
                metrics.barRevenue > 0
                  ? `${Math.round((metrics.barGrossProfit / metrics.barRevenue) * 100)}%`
                  : "—",
            },
          ],
          columns: ["Reference", "Items", "Units", "Payment", "Total", "Cost", "Gross Profit", "Date"],
          rows: [
            ...inPeriod
              .sort((a, b) => (barSaleDate(a)?.getTime() ?? 0) - (barSaleDate(b)?.getTime() ?? 0))
              .map((s) => [
                s.reference ?? "—",
                (s.items ?? []).map((i) => `${i.quantity}× ${i.name}`).join(", ") || "—",
                (s.items ?? []).reduce((n, i) => n + (Number(i.quantity) || 0), 0),
                s.paymentMethod ?? "—",
                money2(Number(s.total) || 0),
                money2(Number(s.cost) || 0),
                money2((Number(s.total) || 0) - (Number(s.cost) || 0)),
                dateTime(barSaleDate(s)),
              ]),
            // Best sellers ride along in the same export so a manager gets
            // the ranking without running a second report.
            ...(best.length
              ? [
                  ["", "", "", "", "", "", "", ""],
                  ["BEST SELLERS", "Units", "Revenue", "", "", "", "", ""],
                  ...best.map((b) => [b.name, b.quantity, money2(b.revenue), "", "", "", "", ""]),
                ]
              : []),
          ],
        };
      }

      case "parking": {
        const inPeriod = data.parking.filter((p) => inRange(parkingDate(p), range));
        return {
          title: "Parking Report",
          kpis: [
            { label: "Parking Revenue", value: money2(metrics.parkingRevenue) },
            { label: "Vehicles", value: String(metrics.parkingCount) },
            {
              label: "Average Fee",
              value: metrics.parkingCount
                ? money2(metrics.parkingRevenue / metrics.parkingCount)
                : "—",
            },
          ],
          columns: ["Plate", "Type", "Driver", "Status", "Amount", "Payment", "Date"],
          rows: inPeriod
            .sort((a, b) => (parkingDate(a)?.getTime() ?? 0) - (parkingDate(b)?.getTime() ?? 0))
            .map((p) => [
              p.vehiclePlate ?? "—",
              p.vehicleType ?? "—",
              p.driverName ?? "—",
              p.status ?? "—",
              money2(Number(p.amount) || 0),
              p.paymentMethod ?? "—",
              dateTime(parkingDate(p)),
            ]),
        };
      }

      case "expenses": {
        const inPeriod = data.expenses.filter((x) => inRange(expenseDate(x), range));
        const byDept = new Map<string, number>();
        for (const x of inPeriod) {
          const key = x.department || "Other";
          byDept.set(key, (byDept.get(key) ?? 0) + (Number(x.amount) || 0));
        }
        const top = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          title: "Expense Report",
          kpis: [
            { label: "Total Expenses", value: money2(metrics.totalExpenses) },
            { label: "Entries", value: String(inPeriod.length) },
            { label: "Largest Category", value: top ? `${top[0]} (${money2(top[1])})` : "—" },
          ],
          columns: ["Department", "Description", "Amount", "Notes", "Date"],
          rows: inPeriod
            .sort((a, b) => (expenseDate(a)?.getTime() ?? 0) - (expenseDate(b)?.getTime() ?? 0))
            .map((x) => [
              x.department ?? "—",
              x.description ?? "—",
              money2(Number(x.amount) || 0),
              x.notes || "—",
              dateTime(expenseDate(x)),
            ]),
        };
      }

      case "financial":
      default: {
        const best = bestSellingProducts(data.barSales, range, 5);
        return {
          title: "Financial Summary",
          kpis: [
            { label: "Total Revenue", value: money2(metrics.totalRevenue) },
            { label: "Total Expenses", value: money2(metrics.totalExpenses) },
            { label: "Net Profit", value: money2(metrics.netProfit) },
            {
              label: "Occupancy",
              value:
                metrics.occupancy.rate === null
                  ? "No rooms registered"
                  : `${metrics.occupancy.rate}% (${metrics.occupancy.occupied}/${metrics.occupancy.totalRooms})`,
            },
          ],
          columns: ["Line Item", "Count", "Amount"],
          rows: [
            ["Accommodation Revenue", metrics.bookingsCount, money2(metrics.accommodationRevenue)],
            ["Restaurant Revenue", metrics.ordersCount, money2(metrics.restaurantRevenue)],
            ["Bar Revenue", metrics.barSalesCount, money2(metrics.barRevenue)],
            ["Parking Revenue", metrics.parkingCount, money2(metrics.parkingRevenue)],
            ["Total Revenue", "", money2(metrics.totalRevenue)],
            ["Recorded Expenses", "", `− ${money2(metrics.totalExpenses)}`],
            ["Net Profit", "", money2(metrics.netProfit)],
            ["", "", ""],
            ["Bar cost of goods", "", money2(metrics.barCost)],
            ["Bar gross profit", "", money2(metrics.barGrossProfit)],
            ["Unpaid bookings", metrics.pendingPayments.count, money2(metrics.pendingPayments.amount)],
            ["Bar stock value (current)", "", money2(metrics.stock.value)],
            [
              "Low / critical stock items (current)",
              metrics.stock.lowCount + metrics.stock.criticalCount,
              "",
            ],
            ...(best.length
              ? [
                  ["", "", ""],
                  ["BEST-SELLING BAR PRODUCTS", "Units", "Revenue"],
                  ...best.map((b) => [b.name, b.quantity, money2(b.revenue)]),
                ]
              : []),
          ],
        };
      }
    }
  }, [report, data, range, metrics, currency]);

  const fileStem = `${built.title.replace(/\s+/g, "-").toLowerCase()}-${range.label
    .replace(/[\s/–]+/g, "-")
    .toLowerCase()}`;

  /**
   * jsPDF and its html2canvas dependency are ~380 KB that only a click on
   * Export needs, so exportUtils is pulled in on demand rather than
   * shipped to every manager who just wants to read the numbers.
   */
  const runExport = async (kind: "csv" | "pdf") => {
    setExporting(kind);
    try {
      const utils = await import("./lib/exportUtils");
      if (kind === "csv") utils.exportToCsv(exportPayload);
      else utils.exportToPdf(exportPayload);
    } catch (err) {
      console.error("Export failed:", err);
      toast.error("Could not generate that export. Please try again.");
    } finally {
      setExporting(null);
    }
  };

  const exportPayload = {
    title: built.title,
    subtitle: `${profile.name ? `${profile.name} · ` : ""}${range.label}`,
    filename: fileStem,
    columns: built.columns,
    rows: built.rows,
    kpis: built.kpis,
  };

  const printReport = () => {
    const w = window.open("", "PRINT", "height=800,width=760");
    if (!w) return;
    const esc = (v: unknown) =>
      String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const kpiHtml = built.kpis
      .map(
        (k) =>
          `<div class="kpi"><div class="kpi-label">${esc(k.label)}</div><div class="kpi-value">${esc(k.value)}</div></div>`
      )
      .join("");
    const headHtml = built.columns.map((c) => `<th>${esc(c)}</th>`).join("");
    const bodyHtml = built.rows
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("");
    w.document.write(`<!doctype html><html><head><title>${esc(built.title)}</title><style>
      body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;padding:24px}
      h1{font-size:20px;margin:0 0 4px}
      .meta{color:#64748b;font-size:12px;margin-bottom:18px}
      .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
      .kpi{border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px}
      .kpi-label{font-size:11px;color:#64748b}
      .kpi-value{font-size:15px;font-weight:bold}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th{background:#0e93a3;color:#fff;text-align:left;padding:6px 8px}
      td{border-bottom:1px solid #e2e8f0;padding:6px 8px}
      tr:nth-child(even) td{background:#f8fafc}
    </style></head><body>
      <h1>${esc(built.title)}</h1>
      <p class="meta">${esc(profile.name)} · Period: ${esc(range.label)} · Generated ${esc(new Date().toLocaleString())}</p>
      <div class="kpis">${kpiHtml}</div>
      <table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
    </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const revenueDelta =
    prior.totalRevenue === 0
      ? null
      : ((metrics.totalRevenue - prior.totalRevenue) / Math.abs(prior.totalRevenue)) * 100;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle={`${built.title} · ${range.label}`}
        actions={
          <>
            <button className="btn btn-secondary" onClick={printReport}>
              <Printer size={16} /> Print
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => runExport("csv")}
              disabled={exporting !== null}
            >
              <FileSpreadsheet size={16} /> {exporting === "csv" ? "Exporting…" : "CSV"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => runExport("pdf")}
              disabled={exporting !== null}
            >
              <Download size={16} /> {exporting === "pdf" ? "Exporting…" : "PDF"}
            </button>
          </>
        }
      />

      {/* REPORT PICKER */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {REPORTS.map((r) => {
          const Icon = r.icon;
          const active = report === r.key;
          return (
            <button
              key={r.key}
              onClick={() => setReport(r.key)}
              aria-pressed={active}
              className="text-left rounded-xl p-3.5 transition"
              style={{
                border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
                background: active ? "var(--primary-soft)" : "var(--surface)",
                boxShadow: active ? "0 0 0 1px var(--primary)" : "var(--shadow-xs)",
              }}
            >
              <span
                className="flex items-center gap-2 font-semibold text-sm"
                style={{ color: active ? "var(--primary-active)" : "var(--text)" }}
              >
                <Icon size={16} />
                {r.label}
              </span>
              <span className="block text-xs muted mt-1">{r.description}</span>
            </button>
          );
        })}
      </div>

      {/* PERIOD */}
      <div className="filter-bar">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <SegmentedControl
            label="Reporting period"
            value={period}
            options={PERIODS}
            onChange={setPeriod}
          />
          {period === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="input"
                style={{ width: 165 }}
                aria-label="Start date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <span className="text-sm muted">to</span>
              <input
                type="date"
                className="input"
                style={{ width: 165 }}
                aria-label="End date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          )}
          <p className="text-sm muted lg:ml-auto">
            Period: <strong style={{ color: "var(--text)" }}>{range.label}</strong>
          </p>
        </div>
      </div>

      {/* KPI STRIP */}
      <StatGrid>
        {built.kpis.map((k, i) => (
          <StatCard
            key={k.label}
            index={i}
            loading={loading}
            label={k.label}
            value={k.value}
            icon={<FileBarChart size={19} />}
            tone={i === 0 ? "success" : i === 1 ? "warning" : "primary"}
            delta={report === "financial" && i === 0 ? revenueDelta : undefined}
          />
        ))}
      </StatGrid>

      {/* DEPARTMENT SPLIT — only meaningful on the whole-business report */}
      {report === "financial" && metrics.totalRevenue > 0 && (
        <Card title="Revenue by Department">
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th className="num">Revenue</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((d) => (
                  <tr key={d.name}>
                    <td className="font-medium" style={{ color: "var(--text)" }}>
                      {d.name}
                    </td>
                    <td className="num">{money(d.revenue, currency)}</td>
                    <td className="num" style={{ color: "var(--text-secondary)" }}>
                      {percent(d.share, "0%")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* REPORT TABLE */}
      <Card title={`${built.title} — ${range.label}`} bodyClassName="">
        <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
          <table className="data-table">
            <thead>
              <tr>
                {built.columns.map((c) => (
                  <th key={c} className={c === "Units" || c === "Revenue" ? "num" : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {built.rows.length ? (
                built.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td
                        key={j}
                        className={j === 0 ? "font-medium" : undefined}
                        style={j === 0 ? { color: "var(--text)" } : undefined}
                      >
                        {c}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={built.columns.length}>
                    <EmptyState
                      icon={<FileBarChart size={24} />}
                      title="Nothing in this period"
                      description="Try a wider date range, or check that records were entered for these dates."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
