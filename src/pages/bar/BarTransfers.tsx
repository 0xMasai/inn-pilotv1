/**
 * Stock Transfer — main store → bar.
 *
 * Total stock is conserved: a transfer only ever shifts units between two
 * buckets on the same product. The quantity is validated here for a fast
 * error message, and again inside the Firestore transaction in
 * lib/bar.transferToBar, which is what actually guarantees the store
 * balance can never go negative.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowLeftRight,
  Boxes,
  History,
  Package,
  Search,
} from "lucide-react";
import { useBarContext } from "./BarLayout";
import { productHealth, STOCK_BADGE, transferToBar } from "../../lib/bar";
import { toDateSafe } from "../../lib/metrics";
import { dateTime, money, num, plural } from "../../lib/format";
import {
  Card,
  EmptyState,
  Field,
  FormError,
  PageHeader,
  StatCard,
  StatGrid,
  TableSkeleton,
  useToast,
} from "../../components/ui";

export default function BarTransfers() {
  const { products, transfers, loading, hotelId, currency } = useBarContext();
  const toast = useToast();

  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const transferable = useMemo(
    () => products.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [products]
  );

  const selected = useMemo(
    () => transferable.find((p) => p.id === productId) ?? null,
    [transferable, productId]
  );

  const requested = Number(quantity) || 0;
  const available = selected?.storeStock ?? 0;
  const overdrawn = !!selected && requested > available;

  const storeTotals = useMemo(() => {
    const active = products.filter((p) => !p.archived);
    return {
      storeUnits: active.reduce((n, p) => n + p.storeStock, 0),
      storeValue: active.reduce((n, p) => n + p.storeStock * p.costPrice, 0),
      barUnits: active.reduce((n, p) => n + p.barStock, 0),
      emptyAtBar: active.filter((p) => p.barStock <= 0 && p.storeStock > 0).length,
    };
  }, [products]);

  const history = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return transfers;
    return transfers.filter((t) => t.productName.toLowerCase().includes(q));
  }, [transfers, search]);

  const submit = async () => {
    if (!hotelId) return setError("No workspace is open. Reload the page and try again.");
    if (!selected) return setError("Choose a product to transfer.");

    setSaving(true);
    setError("");
    const result = await transferToBar(hotelId, {
      productId: selected.id,
      quantity: Math.floor(requested),
      note: note.trim(),
    });
    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(
      `${Math.floor(requested)} ${selected.unit.toLowerCase()}(s) of ${selected.name} moved to the bar`
    );
    setQuantity("");
    setNote("");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Transfer"
        subtitle="Move inventory from the main store to the bar"
        actions={
          <Link to="/dashboard/bar/products" className="btn btn-secondary">
            <Package size={16} /> Products
          </Link>
        }
      />

      <StatGrid columns={4}>
        <StatCard
          index={0}
          loading={loading}
          label="Units in Main Store"
          value={num(storeTotals.storeUnits)}
          icon={<Boxes size={19} />}
          tone="primary"
          hint={`${money(storeTotals.storeValue, currency)} at cost`}
        />
        <StatCard
          index={1}
          loading={loading}
          label="Units at Bar"
          value={num(storeTotals.barUnits)}
          icon={<Package size={19} />}
          tone="purple"
          hint="Ready to sell"
        />
        <StatCard
          index={2}
          loading={loading}
          label="Empty at Bar"
          value={num(storeTotals.emptyAtBar)}
          icon={<ArrowLeftRight size={19} />}
          tone={storeTotals.emptyAtBar > 0 ? "warning" : "success"}
          hint="Out at the bar but held in store"
        />
        <StatCard
          index={3}
          loading={loading}
          label="Transfers Recorded"
          value={num(transfers.length)}
          icon={<History size={19} />}
          tone="success"
          hint="Every move is logged"
        />
      </StatGrid>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* TRANSFER FORM */}
        <Card className="lg:col-span-1" title="New Transfer">
          {transferable.length === 0 ? (
            <EmptyState
              icon={<Package size={22} />}
              title="No products yet"
              description="Add products before moving stock between the store and the bar."
              action={
                <Link to="/dashboard/bar/products" className="btn btn-primary btn-sm">
                  Add products
                </Link>
              }
            />
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Field label="Product" required>
                <select
                  className="select"
                  value={productId}
                  onChange={(e) => {
                    setProductId(e.target.value);
                    setError("");
                  }}
                >
                  <option value="">Select a product…</option>
                  {transferable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.storeStock} in store
                    </option>
                  ))}
                </select>
              </Field>

              {selected && (
                <div
                  className="rounded-lg p-3.5"
                  style={{ background: "var(--surface-muted)" }}
                  aria-live="polite"
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <div className="text-center flex-1">
                      <p className="text-xs muted">Main Store</p>
                      <p className="text-lg font-bold" style={{ color: "var(--text)" }}>
                        {selected.storeStock}
                      </p>
                    </div>
                    <ArrowRight size={18} className="flex-none" style={{ color: "var(--primary)" }} />
                    <div className="text-center flex-1">
                      <p className="text-xs muted">Bar</p>
                      <p className="text-lg font-bold" style={{ color: "var(--text)" }}>
                        {selected.barStock}
                      </p>
                    </div>
                  </div>
                  {requested > 0 && !overdrawn && (
                    <p className="text-xs text-center mt-2.5 pt-2.5" style={{ borderTop: "1px dashed var(--border-strong)", color: "var(--text-secondary)" }}>
                      After transfer: <strong>{available - Math.floor(requested)}</strong> in store,{" "}
                      <strong>{selected.barStock + Math.floor(requested)}</strong> at bar
                    </p>
                  )}
                </div>
              )}

              <Field
                label={`Quantity${selected ? ` (${selected.unit.toLowerCase()}s)` : ""}`}
                required
                hint={selected ? `${available} available in the main store.` : undefined}
              >
                <input
                  type="number"
                  min={1}
                  step={1}
                  max={available || undefined}
                  className="input"
                  value={quantity}
                  onChange={(e) => {
                    setQuantity(e.target.value);
                    setError("");
                  }}
                  placeholder="0"
                  disabled={!selected}
                />
              </Field>

              <Field label="Note" hint="Optional — shift, requester, or reason.">
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Friday evening restock"
                  disabled={!selected}
                />
              </Field>

              {overdrawn && (
                <FormError
                  message={`Only ${available} ${selected?.unit.toLowerCase()}(s) of ${selected?.name} are in the main store.`}
                />
              )}
              <FormError message={error} />

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={saving || !selected || requested <= 0 || overdrawn}
              >
                {saving ? "Transferring…" : "Transfer to bar"}
              </button>
            </form>
          )}
        </Card>

        {/* STOCK POSITION */}
        <Card className="lg:col-span-2" title="Stock Position" bodyClassName="">
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Main Store</th>
                  <th className="num">Bar</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <TableSkeleton rows={5} columns={5} />
                ) : transferable.length ? (
                  transferable.map((p) => {
                    const health = productHealth(p);
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setProductId(p.id)}
                        style={{ cursor: "pointer" }}
                        title={`Transfer ${p.name}`}
                      >
                        <td className="font-medium" style={{ color: "var(--text)" }}>
                          {p.name}
                          <span className="muted text-xs ml-1.5">{p.unit}</span>
                        </td>
                        <td className="num">{num(p.storeStock)}</td>
                        <td className="num font-semibold">{num(p.barStock)}</td>
                        <td className="num" style={{ color: "var(--text-secondary)" }}>
                          {num(p.storeStock + p.barStock)}
                        </td>
                        <td>
                          <span className={`badge ${STOCK_BADGE[health.status]}`}>
                            {health.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState
                        icon={<Boxes size={24} />}
                        title="No products yet"
                        description="Your stock position appears here once products exist."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* AUDIT TRAIL */}
      <Card
        title="Transfer History"
        action={
          <div className="search-wrap" style={{ width: 240 }}>
            <Search size={15} />
            <input
              className="input"
              style={{ height: 34 }}
              aria-label="Search transfer history"
              placeholder="Search product…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
        bodyClassName=""
      >
        <div className="table-wrap" style={{ border: "none" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date &amp; time</th>
                <th>Product</th>
                <th className="num">Quantity</th>
                <th className="num">Store after</th>
                <th className="num">Bar after</th>
                <th>By</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={5} columns={7} />
              ) : history.length ? (
                history.map((t) => (
                  <tr key={t.id}>
                    <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {dateTime(toDateSafe(t.createdAt))}
                    </td>
                    <td className="font-medium" style={{ color: "var(--text)" }}>
                      {t.productName}
                    </td>
                    <td className="num font-semibold" style={{ color: "var(--success-text)" }}>
                      +{plural(t.quantity, t.unit.toLowerCase())}
                    </td>
                    <td className="num" style={{ color: "var(--text-secondary)" }}>
                      {num(t.storeStockAfter)}
                    </td>
                    <td className="num" style={{ color: "var(--text-secondary)" }}>
                      {num(t.barStockAfter)}
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>{t.userEmail || "—"}</td>
                    <td className="muted">{t.note || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon={<History size={24} />}
                      title="No transfers yet"
                      description={
                        transfers.length
                          ? "No transfer matches your search."
                          : "Every store-to-bar movement is recorded here with who moved it and when."
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
