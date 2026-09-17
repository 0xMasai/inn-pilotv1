"use client";
import { useState, useEffect } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { addDoc, onSnapshot, Timestamp } from "firebase/firestore";
import { COLLECTIONS } from "./lib/collections";
import { hotelCollection } from "./lib/hotelScope";
import { useWorkspace } from "./workspace/workspaceContext";
import { logAction } from "./lib/audit";
import { useHotelProfile } from "./lib/hotelProfile";
import { money, plural } from "./lib/format";
import { Plus, X, Printer, Search, Receipt, TrendingDown, Layers } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  EmptyState,
  FormError,
  PageHeader,
  StatCard,
  StatGrid,
  TableSkeleton,
  useToast,
} from "./components/ui";

const toDateIso = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const timestamp = value as { toDate?: () => Date };
  if (typeof timestamp.toDate !== "function") return "";
  const date = timestamp.toDate();
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

interface Expense {
  id?: string;
  department: string;
  description: string;
  amount: number | string;
  expenseDate: string; // ISO string
  notes?: string;
}

const departments = ["Kitchen", "Cleaning", "Maintenance", "Front Desk", "Other"];

export default function ExpensesDashboard() {
  const { hotelId } = useWorkspace();
  const { profile } = useHotelProfile(hotelId);
  const toast = useToast();
  const currency = profile.currency;
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("All");
  const [minAmount, setMinAmount] = useState<number | "">("");
  const [maxAmount, setMaxAmount] = useState<number | "">("");

  const [formData, setFormData] = useState<Expense>({
    department: "",
    description: "",
    amount: "",
    expenseDate: "",
    notes: "",
  });

  /* FIRESTORE LISTENER — every expense recorded for this hotel. */
  useEffect(() => {
    if (!hotelId) return;
    const q = hotelCollection(hotelId, COLLECTIONS.EXPENSES);

    const unsub = onSnapshot(q, (snap) => {
      const data: Expense[] = snap.docs.map((doc) => {
        const raw = doc.data() as Record<string, unknown>;
        return {
          id: doc.id,
          department: typeof raw.department === "string" ? raw.department : "",
          description: typeof raw.description === "string" ? raw.description : "",
          amount: typeof raw.amount === "number" ? raw.amount : Number(raw.amount ?? 0),
          expenseDate: toDateIso(raw.createdAt) || (typeof raw.date === "string" ? raw.date : ""),
          notes: typeof raw.notes === "string" ? raw.notes : undefined,
        };
      });

      setExpenses(
        data.sort((a, b) => b.expenseDate.localeCompare(a.expenseDate))
      );
      setLoading(false);
    });

    return () => unsub();
  }, [hotelId]);

  /* 🔍 FILTER */
  const filteredExpenses = expenses.filter((e) => {
    const matchSearch =
      e.description.toLowerCase().includes(search.toLowerCase()) ||
      e.department.toLowerCase().includes(search.toLowerCase());
    const matchDept = filterDept === "All" || e.department === filterDept;
    const matchMin = minAmount === "" || Number(e.amount) >= minAmount;
    const matchMax = maxAmount === "" || Number(e.amount) <= maxAmount;
    return matchSearch && matchDept && matchMin && matchMax;
  });

  const totalFiltered = filteredExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  /** Which department spends most — the one number an owner scans for first. */
  const topDepartment = (() => {
    const byDept = new Map<string, number>();
    for (const e of expenses) {
      const key = e.department || "Other";
      byDept.set(key, (byDept.get(key) ?? 0) + Number(e.amount || 0));
    }
    return [...byDept.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  })();

  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((p) => ({ ...p, [name]: value }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!formData.department || !formData.description || !formData.amount)
      return setFormError("Department, description and amount are all required.");

    if (Number(formData.amount) <= 0) return setFormError("Amount must be greater than zero.");

    if (!hotelId) return setFormError("No workspace is open. Reload the page and try again.");

    const ref = await addDoc(hotelCollection(hotelId, COLLECTIONS.EXPENSES), {
      department: formData.department,
      description: formData.description,
      amount: Number(formData.amount),
      notes: formData.notes,
      hotelId,
      createdAt: Timestamp.now(),
    });
    logAction(hotelId, "Expense recorded", "expense", ref.id, `${formData.department} · ${money(formData.amount, currency)}`);
    toast.success(`${money(formData.amount, currency)} expense recorded`);

    setOpen(false);
    setFormData({
      department: "",
      description: "",
      amount: "",
      expenseDate: "",
      notes: "",
    });
  };

  const printExpense = (e: Expense) => {
    const win = window.open("", "PRINT", "width=400,height=600");
    if (!win) return;
    win.document.write(`<h2>InnPilot</h2>`);
    win.document.write(`<h3>Expense Voucher</h3>`);
    win.document.write(`<p><b>Department:</b> ${e.department}</p>`);
    win.document.write(`<p><b>Description:</b> ${e.description}</p>`);
    win.document.write(`<p><b>Amount:</b> ${money(e.amount, currency)}</p>`);
    win.document.write(`<p><b>Date:</b> ${new Date(e.expenseDate).toLocaleString()}</p>`);
    win.document.write(`<p><b>Notes:</b> ${e.notes || "-"}</p>`);
    win.print();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        subtitle="Track and review operational spending"
        actions={
          <button onClick={() => setOpen(true)} className="btn btn-primary">
            <Plus size={16} /> New Expense
          </button>
        }
      />

      {/* MODAL */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { setOpen(false); setFormError(""); }}
          >
            <motion.div
              className="modal-panel max-w-xl"
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="New expense"
            >
              <div className="modal-header">
                <h3 className="modal-title">New Expense</h3>
                <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-4">
                <FormError message={formError} />

                <div>
                  <label className="field-label">Department<span className="req">*</span></label>
                  <select name="department" value={formData.department} onChange={handleChange} className="select">
                    <option value="" disabled>Select department</option>
                    {departments.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="field-label">Description<span className="req">*</span></label>
                  <input name="description" placeholder="What was this expense for?" value={formData.description} onChange={handleChange} className="input" />
                </div>

                <div>
                  <label className="field-label">Amount ({currency})<span className="req">*</span></label>
                  <input type="number" name="amount" placeholder="0" value={formData.amount} onChange={handleChange} className="input" />
                </div>

                <div>
                  <label className="field-label">Notes</label>
                  <textarea name="notes" placeholder="Additional details" value={formData.notes} onChange={handleChange} className="textarea" />
                </div>

                <div className="flex justify-end gap-3 pt-1">
                  <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save Expense</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SUMMARY */}
      <StatGrid columns={3}>
        <StatCard
          index={0}
          loading={loading}
          label="Filtered Total"
          value={money(totalFiltered, currency)}
          icon={<TrendingDown size={19} />}
          tone="warning"
          hint={plural(filteredExpenses.length, "entry", "entries")}
        />
        <StatCard
          index={1}
          loading={loading}
          label="All Recorded Spending"
          value={money(expenses.reduce((n, e) => n + Number(e.amount || 0), 0), currency)}
          icon={<Receipt size={19} />}
          tone="primary"
          hint={plural(expenses.length, "entry", "entries")}
        />
        <StatCard
          index={2}
          loading={loading}
          label="Largest Department"
          value={topDepartment ? topDepartment[0] : "—"}
          icon={<Layers size={19} />}
          tone="purple"
          hint={topDepartment ? money(topDepartment[1], currency) : "No spending recorded"}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-4">
        <div className="filter-bar">
          <h3 className="section-title mb-3">Search &amp; filter</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="search-wrap">
              <Search size={16} />
              <input aria-label="Search expenses" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="input" />
            </div>
            <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className="select" aria-label="Department">
              <option value="All">All departments</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            <input type="number" placeholder="Min amount" value={minAmount} onChange={(e) => setMinAmount(e.target.value === "" ? "" : Number(e.target.value))} className="input" aria-label="Minimum amount" />
            <input type="number" placeholder="Max amount" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value === "" ? "" : Number(e.target.value))} className="input" aria-label="Maximum amount" />
          </div>
          <p className="mt-3 text-sm muted">
            Showing <strong className="text-slate-700">{filteredExpenses.length}</strong> of <strong className="text-slate-700">{expenses.length}</strong> expenses
          </p>
        </div>
      </div>

      {/* TABLE */}
      <Card title="Recent Expenses" bodyClassName="">
        <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th>Date</th>
                <th className="text-center">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={5} columns={5} />
              ) : filteredExpenses.length ? (
                filteredExpenses.map((e) => (
                  <tr key={e.id}>
                    <td><span className="badge badge-neutral badge-plain">{e.department}</span></td>
                    <td className="text-slate-700">{e.description}</td>
                    <td className="num font-medium">{money(e.amount, currency)}</td>
                    <td className="text-slate-500 whitespace-nowrap">{new Date(e.expenseDate).toLocaleString()}</td>
                    <td className="text-center">
                      <button onClick={() => printExpense(e)} className="btn btn-secondary btn-sm">
                        <Printer size={15} /> Print
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={<Receipt size={24} />}
                      title="No expenses found"
                      description={
                        expenses.length
                          ? "No expenses match your current filters."
                          : "Record your first expense and it will appear here."
                      }
                      action={
                        !expenses.length ? (
                          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
                            <Plus size={15} /> New Expense
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
    </div>
  );
}
