/**
 * Centralized business calculations.
 *
 * Every KPI card, chart and report derives its numbers from these
 * functions so figures agree across the entire application. Nothing
 * computes revenue inline.
 *
 * Definitions:
 *   Total Revenue = Accommodation + Restaurant + Bar + Parking
 *   Net Profit    = Total Revenue − Recorded Expenses
 *     Only revenue and expenses *recorded in InnPilot* are counted; this
 *     is an operating figure, not an accounting profit.
 *
 * Revenue recognition dates:
 *   Accommodation → checkIn (fallback createdAt)
 *   Restaurant    → createdAt (fallback timestamp)
 *   Bar           → createdAt
 *   Parking       → checkOut when released, else createdAt/checkIn
 *   Expenses      → createdAt (fallback timestamp/date)
 */
import type { BookingStatus } from "./collections";

// ---------- Raw record shapes (as stored in Firestore) ----------

export interface BookingRecord {
  pricePaid?: number;
  paymentStatus?: string;
  status?: BookingStatus;
  isOccupied?: boolean;
  checkIn?: unknown;
  checkOut?: unknown;
  createdAt?: unknown;
  roomNumber?: unknown;
  guestName?: string;
  roomType?: string;
}

export interface OrderRecord {
  clientName?: string;
  orderDetails?: string;
  category?: string;
  price?: number;
  paymentMethod?: string;
  status?: string;
  createdAt?: unknown;
  timestamp?: unknown;
}

export interface BarSaleRecord {
  reference?: string;
  items?: { productId?: string; name?: string; quantity?: number; unitPrice?: number; costPrice?: number }[];
  total?: number;
  cost?: number;
  paymentMethod?: string;
  createdAt?: unknown;
}

export interface ParkingRecord {
  vehiclePlate?: string;
  vehicleType?: string;
  driverName?: string;
  amount?: number;
  status?: string;
  paymentMethod?: string;
  checkIn?: unknown;
  checkOut?: unknown;
  createdAt?: unknown;
}

export interface ExpenseRecord {
  amount?: number;
  department?: string;
  description?: string;
  notes?: string;
  createdAt?: unknown;
  timestamp?: unknown;
  date?: unknown;
}

export interface RoomRecord {
  status?: string;
}

export interface BarProductRecord {
  name?: string;
  category?: string;
  unit?: string;
  costPrice?: number;
  sellingPrice?: number;
  barStock?: number;
  storeStock?: number;
  reorderLevel?: number;
  archived?: boolean;
}

/** Cancelled orders generate no revenue (legacy orders count as completed). */
export const isRevenueOrder = (o: OrderRecord): boolean =>
  (o.status ?? "Paid") !== "Cancelled";

// ---------- Date helpers ----------

export const toDateSafe = (v: unknown): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  // Firestore Timestamps are matched by their toDate() method rather than
  // by `instanceof Timestamp`, so this module stays free of the SDK.
  if (v && typeof v === "object" && "toDate" in v && typeof (v as { toDate: () => unknown }).toDate === "function") {
    try {
      const d = (v as { toDate: () => unknown }).toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

export type DatePreset = "today" | "week" | "month" | "lastMonth" | "all";

export interface DateRange {
  start: Date;
  /** Exclusive. */
  end: Date;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const getRange = (preset: DatePreset, now = new Date()): DateRange => {
  const today = startOfDay(now);
  switch (preset) {
    case "today": {
      const end = new Date(today);
      end.setDate(end.getDate() + 1);
      return { start: today, end, label: "Today" };
    }
    case "week": {
      // Monday-based week.
      const start = new Date(today);
      start.setDate(start.getDate() - ((today.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end, label: "This Week" };
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { start, end, label: "This Month" };
    }
    case "lastMonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end, label: "Last Month" };
    }
    case "all": {
      const end = new Date(today);
      end.setDate(end.getDate() + 1);
      return { start: new Date(2000, 0, 1), end, label: "All Time" };
    }
  }
};

/** Build an inclusive custom range from two calendar dates. */
export const customRange = (start: Date, endInclusive: Date): DateRange => {
  const s = startOfDay(start);
  const e = startOfDay(endInclusive);
  e.setDate(e.getDate() + 1); // make end exclusive
  return {
    start: s,
    end: e,
    label: `${s.toLocaleDateString()} – ${endInclusive.toLocaleDateString()}`,
  };
};

export const inRange = (d: Date | null, range: DateRange): boolean =>
  !!d && d >= range.start && d < range.end;

/** The equivalent range one period earlier — used for period-on-period deltas. */
export const previousRange = (range: DateRange): DateRange => {
  const span = range.end.getTime() - range.start.getTime();
  return {
    start: new Date(range.start.getTime() - span),
    end: new Date(range.start.getTime()),
    label: `Previous ${range.label}`,
  };
};

// ---------- Record accessors ----------

/** Legacy bookings have no status; derive one the same way everywhere. */
export const bookingStatusOf = (b: BookingRecord): BookingStatus =>
  b.status ?? (b.isOccupied ? "Checked In" : "Confirmed");

/** Cancelled / no-show bookings generate no revenue. */
export const isRevenueBooking = (b: BookingRecord): boolean => {
  const s = bookingStatusOf(b);
  return s !== "Cancelled" && s !== "No Show";
};

export const bookingDate = (b: BookingRecord) =>
  toDateSafe(b.checkIn) ?? toDateSafe(b.createdAt);
export const orderDate = (o: OrderRecord) =>
  toDateSafe(o.createdAt) ?? toDateSafe(o.timestamp);
export const barSaleDate = (s: BarSaleRecord) => toDateSafe(s.createdAt);
/** A parking fee is earned when the vehicle leaves; while parked, on arrival. */
export const parkingDate = (p: ParkingRecord) =>
  toDateSafe(p.checkOut) ?? toDateSafe(p.createdAt) ?? toDateSafe(p.checkIn);
export const expenseDate = (e: ExpenseRecord) =>
  toDateSafe(e.createdAt) ?? toDateSafe(e.timestamp) ?? toDateSafe(e.date);

// ---------- Stock ----------

export type StockStatus = "Good" | "Low" | "Critical";

/**
 * Where a product sits against its reorder level.
 *
 * Critical is deliberately reached *before* zero — at or below half the
 * reorder level — so a manager is warned while there is still time to
 * restock, not once the bar has already run dry. With no reorder level
 * set, only genuinely empty stock is flagged.
 */
export const stockStatusOf = (stock: number, reorderLevel: number): StockStatus => {
  if (stock <= 0) return "Critical";
  if (reorderLevel <= 0) return "Good";
  if (stock <= reorderLevel / 2) return "Critical";
  if (stock <= reorderLevel) return "Low";
  return "Good";
};

// ---------- Aggregation ----------

export interface MetricsInput {
  bookings: BookingRecord[];
  orders: OrderRecord[];
  barSales: BarSaleRecord[];
  parking: ParkingRecord[];
  expenses: ExpenseRecord[];
  rooms: RoomRecord[];
  barProducts: BarProductRecord[];
}

export const emptyMetricsInput = (): MetricsInput => ({
  bookings: [],
  orders: [],
  barSales: [],
  parking: [],
  expenses: [],
  rooms: [],
  barProducts: [],
});

export interface Metrics {
  accommodationRevenue: number;
  restaurantRevenue: number;
  barRevenue: number;
  parkingRevenue: number;
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  /** Cost of the bar goods sold in this period. */
  barCost: number;
  barGrossProfit: number;
  bookingsCount: number;
  ordersCount: number;
  barSalesCount: number;
  parkingCount: number;
  pendingPayments: { count: number; amount: number };
  occupancy: {
    totalRooms: number;
    occupied: number;
    available: number;
    /** 0–100, null when no rooms are registered. */
    rate: number | null;
  };
  /** Point-in-time, not period-bound: current bar inventory health. */
  stock: {
    /** Value of bar + store inventory at cost. */
    value: number;
    lowCount: number;
    criticalCount: number;
  };
}

export const computeMetrics = (input: MetricsInput, range: DateRange): Metrics => {
  let accommodationRevenue = 0;
  let bookingsCount = 0;
  let pendingCount = 0;
  let pendingAmount = 0;

  for (const b of input.bookings) {
    if (!isRevenueBooking(b)) continue;
    if (!inRange(bookingDate(b), range)) continue;
    bookingsCount += 1;
    const amount = Number(b.pricePaid) || 0;
    accommodationRevenue += amount;
    if ((b.paymentStatus || "").toLowerCase() === "pending") {
      pendingCount += 1;
      pendingAmount += amount;
    }
  }

  let restaurantRevenue = 0;
  let ordersCount = 0;
  for (const o of input.orders) {
    if (!isRevenueOrder(o)) continue;
    if (!inRange(orderDate(o), range)) continue;
    ordersCount += 1;
    restaurantRevenue += Number(o.price) || 0;
  }

  let barRevenue = 0;
  let barCost = 0;
  let barSalesCount = 0;
  for (const s of input.barSales) {
    if (!inRange(barSaleDate(s), range)) continue;
    barSalesCount += 1;
    barRevenue += Number(s.total) || 0;
    barCost += Number(s.cost) || 0;
  }

  let parkingRevenue = 0;
  let parkingCount = 0;
  for (const p of input.parking) {
    if (!inRange(parkingDate(p), range)) continue;
    parkingCount += 1;
    parkingRevenue += Number(p.amount) || 0;
  }

  let totalExpenses = 0;
  for (const x of input.expenses) {
    if (!inRange(expenseDate(x), range)) continue;
    totalExpenses += Number(x.amount) || 0;
  }

  const totalRevenue = accommodationRevenue + restaurantRevenue + barRevenue + parkingRevenue;

  const totalRooms = input.rooms.length;
  const occupied = input.rooms.filter((r) => r.status === "Occupied").length;
  const available = input.rooms.filter((r) => r.status === "Available").length;

  let stockValue = 0;
  let lowCount = 0;
  let criticalCount = 0;
  for (const p of input.barProducts) {
    if (p.archived) continue;
    const bar = Number(p.barStock) || 0;
    const store = Number(p.storeStock) || 0;
    stockValue += (bar + store) * (Number(p.costPrice) || 0);
    const status = stockStatusOf(bar, Number(p.reorderLevel) || 0);
    if (status === "Critical") criticalCount += 1;
    else if (status === "Low") lowCount += 1;
  }

  return {
    accommodationRevenue,
    restaurantRevenue,
    barRevenue,
    parkingRevenue,
    totalRevenue,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
    barCost,
    barGrossProfit: barRevenue - barCost,
    bookingsCount,
    ordersCount,
    barSalesCount,
    parkingCount,
    pendingPayments: { count: pendingCount, amount: pendingAmount },
    occupancy: {
      totalRooms,
      occupied,
      available,
      rate: totalRooms ? Math.round((occupied / totalRooms) * 100) : null,
    },
    stock: { value: stockValue, lowCount, criticalCount },
  };
};

/** Revenue split by department, ready for a chart or a report table. */
export interface DepartmentSlice {
  name: string;
  revenue: number;
  /** Share of total revenue, 0–100. */
  share: number;
}

export const departmentBreakdown = (m: Metrics): DepartmentSlice[] => {
  const rows = [
    { name: "Accommodation", revenue: m.accommodationRevenue },
    { name: "Restaurant", revenue: m.restaurantRevenue },
    { name: "Bar", revenue: m.barRevenue },
    { name: "Parking", revenue: m.parkingRevenue },
  ];
  return rows.map((r) => ({
    ...r,
    share: m.totalRevenue > 0 ? (r.revenue / m.totalRevenue) * 100 : 0,
  }));
};

/** Units sold and revenue per bar product over a range — the best-seller list. */
export interface ProductSales {
  productId: string;
  name: string;
  quantity: number;
  revenue: number;
}

export const bestSellingProducts = (
  sales: BarSaleRecord[],
  range: DateRange,
  limit = 10
): ProductSales[] => {
  const index = new Map<string, ProductSales>();
  for (const sale of sales) {
    if (!inRange(barSaleDate(sale), range)) continue;
    for (const item of sale.items ?? []) {
      const key = item.productId || item.name || "unknown";
      const row = index.get(key) ?? {
        productId: key,
        name: item.name ?? "Unknown product",
        quantity: 0,
        revenue: 0,
      };
      row.quantity += Number(item.quantity) || 0;
      row.revenue += (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
      index.set(key, row);
    }
  }
  return [...index.values()].sort((a, b) => b.quantity - a.quantity).slice(0, limit);
};

// ---------- Trend series ----------

export interface TrendPoint {
  label: string;
  revenue: number;
  expenses: number;
}

/** Every dated revenue event in the input, as (date, amount) pairs. */
const revenueEvents = (input: MetricsInput): [Date | null, number][] => [
  ...input.bookings
    .filter(isRevenueBooking)
    .map((b) => [bookingDate(b), Number(b.pricePaid) || 0] as [Date | null, number]),
  ...input.orders
    .filter(isRevenueOrder)
    .map((o) => [orderDate(o), Number(o.price) || 0] as [Date | null, number]),
  ...input.barSales.map((s) => [barSaleDate(s), Number(s.total) || 0] as [Date | null, number]),
  ...input.parking.map((p) => [parkingDate(p), Number(p.amount) || 0] as [Date | null, number]),
];

const expenseEvents = (input: MetricsInput): [Date | null, number][] =>
  input.expenses.map((x) => [expenseDate(x), Number(x.amount) || 0] as [Date | null, number]);

/** One point per month: used when a range is too long for a daily series. */
const monthlySeries = (input: MetricsInput, range: DateRange): TrendPoint[] => {
  const all = [...revenueEvents(input), ...expenseEvents(input)];
  const inWindow = all
    .map(([d]) => d)
    .filter((d): d is Date => !!d && d >= range.start && d < range.end);
  if (!inWindow.length) return [];

  // Clamp the start to the earliest dated record so "All Time" doesn't
  // produce hundreds of empty months.
  const earliest = new Date(Math.min(...inWindow.map((d) => d.getTime())));
  const start = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const index = new Map<string, TrendPoint>();
  for (let m = new Date(start); m < range.end; m.setMonth(m.getMonth() + 1)) {
    index.set(key(m), {
      label: m.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
      revenue: 0,
      expenses: 0,
    });
  }

  const add = (date: Date | null, field: "revenue" | "expenses", amount: number) => {
    if (!date || date < range.start || date >= range.end) return;
    const p = index.get(key(date));
    if (p) p[field] += amount;
  };
  for (const [d, amount] of revenueEvents(input)) add(d, "revenue", amount);
  for (const [d, amount] of expenseEvents(input)) add(d, "expenses", amount);

  return [...index.values()];
};

/**
 * One point per day across the range: total revenue vs recorded expenses.
 * Ranges longer than ~3 months automatically switch to monthly points.
 */
export const dailySeries = (input: MetricsInput, range: DateRange): TrendPoint[] => {
  const days: Date[] = [];
  for (let d = new Date(range.start); d < range.end; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }
  if (days.length === 0) return [];
  if (days.length > 92) return monthlySeries(input, range);

  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const index = new Map<string, TrendPoint>();
  const manyDays = days.length > 10;
  for (const d of days) {
    index.set(key(d), {
      label: manyDays
        ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
        : d.toLocaleDateString(undefined, { weekday: "short" }),
      revenue: 0,
      expenses: 0,
    });
  }

  const add = (date: Date | null, field: "revenue" | "expenses", amount: number) => {
    if (!date) return;
    const p = index.get(key(date));
    if (p) p[field] += amount;
  };
  for (const [d, amount] of revenueEvents(input)) add(d, "revenue", amount);
  for (const [d, amount] of expenseEvents(input)) add(d, "expenses", amount);

  return [...index.values()];
};

// ---------- Unified transaction feed ----------

export type TransactionKind = "Accommodation" | "Restaurant" | "Bar" | "Parking" | "Expense";

export interface Transaction {
  kind: TransactionKind;
  description: string;
  /** Positive for revenue, negative for expenses. */
  amount: number;
  at: Date | null;
}

/**
 * Every money movement in the period as one reverse-chronological list —
 * what the dashboard's "Recent transactions" panel shows.
 */
export const recentTransactions = (
  input: MetricsInput,
  range: DateRange,
  limit = 8
): Transaction[] => {
  const rows: Transaction[] = [];

  for (const b of input.bookings) {
    if (!isRevenueBooking(b)) continue;
    const at = bookingDate(b);
    if (!inRange(at, range)) continue;
    rows.push({
      kind: "Accommodation",
      description: `${b.guestName || "Guest"}${b.roomNumber ? ` · Room ${b.roomNumber}` : ""}`,
      amount: Number(b.pricePaid) || 0,
      at,
    });
  }
  for (const o of input.orders) {
    if (!isRevenueOrder(o)) continue;
    const at = orderDate(o);
    if (!inRange(at, range)) continue;
    rows.push({
      kind: "Restaurant",
      description: `${o.clientName || "Walk-in"} · ${o.category || "Order"}`,
      amount: Number(o.price) || 0,
      at,
    });
  }
  for (const s of input.barSales) {
    const at = barSaleDate(s);
    if (!inRange(at, range)) continue;
    const lines = s.items?.length ?? 0;
    rows.push({
      kind: "Bar",
      description: `${s.reference || "Sale"} · ${lines} item${lines === 1 ? "" : "s"}`,
      amount: Number(s.total) || 0,
      at,
    });
  }
  for (const p of input.parking) {
    const at = parkingDate(p);
    if (!inRange(at, range)) continue;
    rows.push({
      kind: "Parking",
      description: `${p.vehiclePlate || "Vehicle"}${p.vehicleType ? ` · ${p.vehicleType}` : ""}`,
      amount: Number(p.amount) || 0,
      at,
    });
  }
  for (const x of input.expenses) {
    const at = expenseDate(x);
    if (!inRange(at, range)) continue;
    rows.push({
      kind: "Expense",
      description: `${x.department || "General"} · ${x.description || "Expense"}`,
      amount: -(Number(x.amount) || 0),
      at,
    });
  }

  return rows
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, limit);
};
