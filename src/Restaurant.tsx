"use client";
import { useState, useEffect, useMemo } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { addDoc, onSnapshot, updateDoc } from "firebase/firestore";
import { hotelCollection, hotelDoc } from "./lib/hotelScope";
import { useWorkspace } from "./workspace/workspaceContext";
import {
  Plus,
  X,
  Printer,
  Search,
  Utensils,
  CheckCircle2,
  Banknote,
  Ban,
  ReceiptText,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { COLLECTIONS } from "./lib/collections";
import { getRange, inRange, orderDate } from "./lib/metrics";
import { logAction } from "./lib/audit";
import { useHotelProfile } from "./lib/hotelProfile";
import { money, plural } from "./lib/format";
import {
  Card,
  ConfirmDialog,
  EmptyState,
  FormError,
  PageHeader,
  StatCard,
  StatGrid,
  TableSkeleton,
  useToast,
} from "./components/ui";

type OrderStatus = "Open" | "Served" | "Paid" | "Cancelled";
type PaymentMethod = "Cash" | "Mobile Money" | "Card";

interface Order {
  id?: string;
  clientName: string;
  clientPhoneNumber?: string;
  orderDetails: string;
  category: "Breakfast" | "Lunch" | "Dinner" | "Cocktails";
  price: number;
  status?: OrderStatus;
  paymentMethod?: PaymentMethod;
  createdAt: string;
}

const categories = ["Breakfast", "Lunch", "Dinner", "Cocktails"] as const;
const paymentMethods: PaymentMethod[] = ["Cash", "Mobile Money", "Card"];

const categoryBadge: Record<typeof categories[number], string> = {
  Breakfast: "badge-warning badge-plain",
  Lunch: "badge-success badge-plain",
  Dinner: "badge-info badge-plain",
  Cocktails: "badge-neutral badge-plain",
};

const statusBadge: Record<OrderStatus, string> = {
  Open: "badge-info",
  Served: "badge-warning",
  Paid: "badge-success",
  Cancelled: "badge-danger",
};

/** Legacy orders predate the lifecycle — they were recorded as completed sales. */
const orderStatusOf = (o: Order): OrderStatus => o.status ?? "Paid";

export default function RestaurantDashboard() {
  const { hotelId } = useWorkspace();
  const { profile } = useHotelProfile(hotelId);
  const toast = useToast();
  const currency = profile.currency;
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);

  const initialFormData: Order = {
    clientName: "",
    clientPhoneNumber: "",
    orderDetails: "",
    category: "Breakfast",
    price: 0,
    paymentMethod: "Cash",
    createdAt: new Date().toISOString(),
  };

  const [formData, setFormData] = useState<Order>(initialFormData);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<"All" | typeof categories[number]>("All");
  const [filterStatus, setFilterStatus] = useState<"All" | OrderStatus>("All");

  // Fetch every order recorded for this hotel.
  useEffect(() => {
    if (!hotelId) return;
    const unsub = onSnapshot(hotelCollection(hotelId, COLLECTIONS.RESTAURANT), (snapshot) => {
      const data = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Order),
      }));

      setOrders(data.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
      setLoading(false);
    });

    return () => unsub();
  }, [hotelId]);

  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: name === "price" ? Number(value) || 0 : value,
    }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!formData.clientName || !formData.orderDetails || !formData.price) {
      setFormError("Client name, order details and price are all required.");
      return;
    }

    if (!hotelId) return setFormError("No workspace is open. Reload the page and try again.");

    try {
      const ref = await addDoc(hotelCollection(hotelId, COLLECTIONS.RESTAURANT), {
        ...formData,
        status: "Open" as OrderStatus,
        hotelId,
        createdAt: new Date().toISOString(),
      });
      logAction(hotelId, "Order created", "order", ref.id, `${formData.clientName} · ${formData.category} · ${money(formData.price, currency)}`);
      toast.success(`Order for ${formData.clientName} recorded`);

      setFormData({
        ...initialFormData,
        createdAt: new Date().toISOString(),
      });

      setOpen(false);
    } catch (err) {
      console.error("Failed to save order:", err);
      setFormError("Could not save this order. Please try again.");
    }
  };

  const setStatus = async (o: Order, status: OrderStatus) => {
    if (!o.id || !hotelId) return;
    try {
      await updateDoc(hotelDoc(hotelId, COLLECTIONS.RESTAURANT, o.id), { status });
      logAction(hotelId, `Order ${status.toLowerCase()}`, "order", o.id, `${o.clientName} · ${money(o.price, currency)}`);
      toast.success(`${o.clientName}'s order marked ${status.toLowerCase()}`);
    } catch (err) {
      console.error("Failed to update order:", err);
      toast.error("Could not update that order.");
    }
  };

  const printReceipt = (order: Order) => {
    const w = window.open("", "PRINT", "height=600,width=400");
    if (!w) return;

    w.document.write(`
      <html>
        <head><title>Restaurant Receipt</title></head>
        <body>
          <h2>Restaurant Receipt</h2>
          <p><strong>Client:</strong> ${order.clientName}</p>
          <p><strong>Order:</strong> ${order.orderDetails}</p>
          <p><strong>Category:</strong> ${order.category}</p>
          <p><strong>Price:</strong> ${money(order.price, currency)}</p>
          <p><strong>Status:</strong> ${orderStatusOf(order)}</p>
          <p><strong>Payment:</strong> ${order.paymentMethod ?? "-"}</p>
          <p><strong>Date:</strong> ${new Date(order.createdAt).toLocaleString()}</p>
        </body>
      </html>
    `);

    w.document.close();
    w.focus();
    w.print();
  };

  // Today's stats (same range logic as the dashboard).
  const todayStats = useMemo(() => {
    const today = getRange("today");
    let sales = 0;
    let count = 0;
    let openCount = 0;
    for (const o of orders) {
      const st = orderStatusOf(o);
      if (st === "Open" || st === "Served") openCount += 1;
      if (st === "Cancelled") continue;
      if (!inRange(orderDate(o), today)) continue;
      count += 1;
      sales += Number(o.price) || 0;
    }
    return { sales, count, openCount };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchesSearch =
        search === "" ||
        o.clientName.toLowerCase().includes(search.toLowerCase()) ||
        o.orderDetails.toLowerCase().includes(search.toLowerCase());

      const matchesCategory = filterCategory === "All" ? true : o.category === filterCategory;
      const matchesStatus = filterStatus === "All" ? true : orderStatusOf(o) === filterStatus;

      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [orders, search, filterCategory, filterStatus]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Restaurant"
        subtitle="Take orders, track service and record payments"
        actions={
          <button onClick={() => setOpen(true)} className="btn btn-primary">
            <Plus size={16} /> New Order
          </button>
        }
      />

      <StatGrid columns={3}>
        <StatCard
          index={0}
          loading={loading}
          label="Today's Sales"
          value={money(todayStats.sales, currency)}
          icon={<Banknote size={19} />}
          tone="success"
          hint={plural(todayStats.count, "order")}
        />
        <StatCard
          index={1}
          loading={loading}
          label="Today's Orders"
          value={String(todayStats.count)}
          icon={<ReceiptText size={19} />}
          tone="orange"
          hint={
            todayStats.count > 0
              ? `${money(todayStats.sales / todayStats.count, currency)} average`
              : "No orders yet today"
          }
        />
        <StatCard
          index={2}
          loading={loading}
          label="Open Orders"
          value={String(todayStats.openCount)}
          icon={<Utensils size={19} />}
          tone={todayStats.openCount > 0 ? "warning" : "success"}
          hint="Awaiting service or payment"
        />
      </StatGrid>

      {/* MODAL */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { setOpen(false); setFormData(initialFormData); setFormError(""); }}
          >
            <motion.div
              className="modal-panel max-w-2xl"
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="New order"
            >
              <div className="modal-header">
                <h2 className="modal-title">New Order</h2>
                <button
                  className="icon-btn"
                  onClick={() => { setOpen(false); setFormData(initialFormData); setFormError(""); }}
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* FORM */}
              <form className="p-6 space-y-5" onSubmit={handleSubmit}>
                <FormError message={formError} />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="field-label">Client name<span className="req">*</span></label>
                    <input type="text" name="clientName" value={formData.clientName} onChange={handleChange} placeholder="Enter client name" className="input" required />
                  </div>
                  <div>
                    <label className="field-label">Phone number</label>
                    <input type="tel" name="clientPhoneNumber" value={formData.clientPhoneNumber ?? ""} onChange={handleChange} placeholder="+256 7xx xxx xxx" className="input" />
                  </div>
                  <div>
                    <label className="field-label">Category</label>
                    <select name="category" value={formData.category} onChange={handleChange} className="select">
                      {categories.map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label">Price ({currency})<span className="req">*</span></label>
                    <input type="number" name="price" value={formData.price === 0 ? "" : formData.price} onChange={handleChange} placeholder="Enter price" className="input" required />
                  </div>
                  <div>
                    <label className="field-label">Payment method</label>
                    <select name="paymentMethod" value={formData.paymentMethod} onChange={handleChange} className="select">
                      {paymentMethods.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="field-label">Order details<span className="req">*</span></label>
                  <textarea name="orderDetails" value={formData.orderDetails} onChange={handleChange} placeholder="Describe the order…" className="textarea" required />
                </div>

                <div className="flex justify-end gap-3 pt-1">
                  <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setFormData(initialFormData); setFormError(""); }}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Submit Order</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FILTERS */}
      <div className="filter-bar">
        <h3 className="section-title mb-3">Search &amp; filter</h3>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="search-wrap">
            <Search size={16} />
            <input type="text" aria-label="Search orders" placeholder="Search by client or order…" value={search} onChange={(e) => setSearch(e.target.value)} className="input" />
          </div>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value as "All" | typeof categories[number])} className="select" aria-label="Category">
            <option value="All">All categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as OrderStatus | "All")} className="select" aria-label="Order status">
            <option value="All">All statuses</option>
            <option value="Open">Open</option>
            <option value="Served">Served</option>
            <option value="Paid">Paid</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
        <p className="mt-3 text-sm muted">
          Showing <strong className="text-slate-700">{filteredOrders.length}</strong> of <strong className="text-slate-700">{orders.length}</strong> orders
        </p>
      </div>

      {/* ORDERS TABLE */}
      <Card title="Recent Orders" bodyClassName="">
        <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Order</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Date</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={5} columns={8} />
              ) : filteredOrders.length ? (
                filteredOrders.map((o) => {
                  const st = orderStatusOf(o);
                  return (
                    <tr key={o.id}>
                      <td className="font-medium text-slate-800">{o.clientName}</td>
                      <td className="max-w-xs truncate">{o.orderDetails}</td>
                      <td>
                        <span className={`badge ${categoryBadge[o.category]}`}>{o.category}</span>
                      </td>
                      <td className="num font-medium">{money(o.price, currency)}</td>
                      <td className="text-slate-500">{o.paymentMethod ?? "-"}</td>
                      <td>
                        <span className={`badge ${statusBadge[st]}`}>{st}</span>
                      </td>
                      <td className="text-slate-500 whitespace-nowrap">{new Date(o.createdAt).toLocaleString()}</td>
                      <td>
                        <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                          {st === "Open" && (
                            <>
                              <button onClick={() => setStatus(o, "Served")} className="btn btn-secondary btn-sm" title="Mark as served">
                                <CheckCircle2 size={14} /> Served
                              </button>
                              <button onClick={() => setCancelTarget(o)} className="btn btn-ghost btn-sm" title="Cancel order">
                                <Ban size={14} />
                              </button>
                            </>
                          )}
                          {(st === "Open" || st === "Served") && (
                            <button onClick={() => setStatus(o, "Paid")} className="btn btn-success btn-sm" title="Mark as paid">
                              <Banknote size={14} /> Paid
                            </button>
                          )}
                          <button onClick={() => printReceipt(o)} className="btn btn-ghost btn-sm" title="Print receipt">
                            <Printer size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={<Utensils size={24} />}
                      title="No orders found"
                      description={
                        orders.length
                          ? "No orders match your current filters."
                          : "Record your first order and it will appear here."
                      }
                      action={
                        !orders.length ? (
                          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
                            <Plus size={15} /> New Order
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

      <ConfirmDialog
        open={!!cancelTarget}
        title="Cancel this order?"
        message={`${cancelTarget?.clientName ?? "This order"}'s order will be marked cancelled and excluded from revenue. This cannot be undone.`}
        confirmLabel="Cancel order"
        onConfirm={() => {
          if (cancelTarget) setStatus(cancelTarget, "Cancelled");
          setCancelTarget(null);
        }}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
