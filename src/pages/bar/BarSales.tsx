/**
 * Bar Sales — a lightweight POS.
 *
 * Tap a product to add it, adjust quantity, pick a tender, save. Totals
 * are priced locally by lib/bar.priceCart so the screen stays responsive,
 * but the authoritative check happens inside the Firestore transaction in
 * recordSale — this UI's stock guard is a courtesy, not the safety net.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Beer,
  Boxes,
  Minus,
  Plus,
  Receipt,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { useBarContext } from "./BarLayout";
import {
  priceCart,
  productHealth,
  recordSale,
  STOCK_BADGE,
  type BarProduct,
  type CartLine,
} from "../../lib/bar";
import { PAYMENT_METHODS, type PaymentMethod } from "../../lib/collections";
import { barSaleDate, inRange, getRange } from "../../lib/metrics";
import { money, plural, timeShort } from "../../lib/format";
import {
  Card,
  EmptyState,
  Field,
  FormError,
  PageHeader,
  useToast,
} from "../../components/ui";

export default function BarSales() {
  const { products, sales, loading, hotelId, currency } = useBarContext();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const sellable = useMemo(
    () => products.filter((p) => !p.archived),
    [products]
  );

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(sellable.map((p) => p.category))).sort()],
    [sellable]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sellable.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (category !== "All" && p.category !== category) return false;
      return true;
    });
  }, [sellable, search, category]);

  const cart = useMemo(() => priceCart(lines, products), [lines, products]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const todayTotal = useMemo(() => {
    const today = getRange("today");
    return sales
      .filter((s) => inRange(barSaleDate(s), today))
      .reduce((sum, s) => sum + s.total, 0);
  }, [sales]);

  /** Adding never exceeds what the bar physically holds. */
  const addLine = (product: BarProduct) => {
    setError("");
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === product.id);
      if (!existing) return [...prev, { productId: product.id, quantity: 1 }];
      if (existing.quantity >= product.barStock) return prev;
      return prev.map((l) =>
        l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l
      );
    });
  };

  const setQuantity = (productId: string, quantity: number) => {
    const product = byId.get(productId);
    const capped = Math.max(0, Math.min(quantity, product?.barStock ?? 0));
    setLines((prev) =>
      capped === 0
        ? prev.filter((l) => l.productId !== productId)
        : prev.map((l) => (l.productId === productId ? { ...l, quantity: capped } : l))
    );
  };

  const removeLine = (productId: string) =>
    setLines((prev) => prev.filter((l) => l.productId !== productId));

  const clearCart = () => {
    setLines([]);
    setNote("");
    setError("");
  };

  const save = async () => {
    if (!hotelId) return setError("No workspace is open. Reload the page and try again.");
    if (!lines.length) return setError("Add at least one product to the sale.");

    setSaving(true);
    setError("");
    const result = await recordSale(hotelId, { lines, paymentMethod, note: note.trim() });
    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(`Sale ${result.data.reference} saved · ${money(result.data.total, currency)}`);
    clearCart();
  };

  const recent = sales.slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        subtitle={`Point of sale · ${money(todayTotal, currency)} taken today`}
        actions={
          <Link to="/dashboard/bar/transfers" className="btn btn-secondary">
            <Boxes size={16} /> Transfer stock
          </Link>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
        {/* PRODUCT PICKER */}
        <div className="lg:col-span-3 space-y-4">
          <div className="filter-bar">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="search-wrap">
                <Search size={16} />
                <input
                  className="input"
                  aria-label="Search products"
                  placeholder="Search products…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="select"
                aria-label="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c === "All" ? "All categories" : c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 88, borderRadius: 10 }} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Beer size={24} />}
                title={sellable.length ? "No products match" : "No products yet"}
                description={
                  sellable.length
                    ? "Try a different search or category."
                    : "Add products to your catalogue before ringing up a sale."
                }
                action={
                  !sellable.length ? (
                    <Link to="/dashboard/bar/products" className="btn btn-primary btn-sm">
                      <Plus size={15} /> Add products
                    </Link>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {visible.map((product) => {
                const health = productHealth(product);
                const inCart = lines.find((l) => l.productId === product.id)?.quantity ?? 0;
                const soldOut = product.barStock <= 0;
                const maxed = inCart >= product.barStock;
                return (
                  <button
                    key={product.id}
                    className={`pos-tile ${inCart > 0 ? "is-selected" : ""}`}
                    onClick={() => addLine(product)}
                    disabled={soldOut || maxed}
                    title={
                      soldOut
                        ? `${product.name} is out of stock at the bar`
                        : maxed
                          ? `Only ${product.barStock} in stock`
                          : `Add ${product.name}`
                    }
                  >
                    <span
                      className="text-sm font-semibold leading-snug line-clamp-2"
                      style={{ color: "var(--text)" }}
                    >
                      {product.name}
                    </span>
                    <span className="text-sm font-bold" style={{ color: "var(--primary)" }}>
                      {money(product.sellingPrice, currency)}
                    </span>
                    <span className="flex items-center justify-between gap-2 mt-auto pt-1">
                      <span className="text-xs muted">
                        {product.barStock} {product.unit.toLowerCase()}
                      </span>
                      {inCart > 0 ? (
                        <span
                          className="text-xs font-bold px-1.5 py-0.5 rounded"
                          style={{ background: "var(--primary)", color: "#fff" }}
                        >
                          {inCart}
                        </span>
                      ) : (
                        health.status !== "Good" && (
                          <span className={`badge ${STOCK_BADGE[health.status]}`} style={{ fontSize: "0.65rem" }}>
                            {health.status}
                          </span>
                        )
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* CART */}
        <div className="lg:col-span-2 lg:sticky lg:top-[88px] space-y-5">
          <Card
            title="Current Sale"
            action={
              lines.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={clearCart} disabled={saving}>
                  Clear
                </button>
              )
            }
          >
            {cart.items.length === 0 ? (
              <EmptyState
                icon={<ShoppingCart size={22} />}
                title="Cart is empty"
                description="Tap a product to start a sale."
              />
            ) : (
              <div className="space-y-4">
                <ul className="space-y-3">
                  {cart.items.map((item) => {
                    const product = byId.get(item.productId);
                    return (
                      <li key={item.productId} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p
                            className="text-sm font-medium truncate"
                            style={{ color: "var(--text)" }}
                          >
                            {item.name}
                          </p>
                          <p className="text-xs muted">
                            {money(item.unitPrice, currency)} each
                          </p>
                        </div>

                        <div className="stepper flex-none">
                          <button
                            onClick={() => setQuantity(item.productId, item.quantity - 1)}
                            aria-label={`Reduce ${item.name}`}
                          >
                            <Minus size={13} />
                          </button>
                          <input
                            type="number"
                            value={item.quantity}
                            min={0}
                            max={product?.barStock ?? 0}
                            onChange={(e) =>
                              setQuantity(item.productId, Math.floor(Number(e.target.value) || 0))
                            }
                            aria-label={`${item.name} quantity`}
                          />
                          <button
                            onClick={() => setQuantity(item.productId, item.quantity + 1)}
                            disabled={item.quantity >= (product?.barStock ?? 0)}
                            aria-label={`Add ${item.name}`}
                          >
                            <Plus size={13} />
                          </button>
                        </div>

                        <span
                          className="text-sm font-semibold num flex-none"
                          style={{ width: 92, color: "var(--text)" }}
                        >
                          {money(item.lineTotal, currency)}
                        </span>

                        <button
                          className="icon-btn flex-none"
                          style={{ width: 28, height: 28 }}
                          onClick={() => removeLine(item.productId)}
                          aria-label={`Remove ${item.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    );
                  })}
                </ul>

                <div>
                  <div className="kv">
                    <span className="kv-label">{plural(cart.items.length, "line")}</span>
                    <span className="kv-value">
                      {cart.items.reduce((n, i) => n + i.quantity, 0)} units
                    </span>
                  </div>
                  <div className="kv">
                    <span className="kv-label">Cost of goods</span>
                    <span className="kv-value">{money(cart.cost, currency)}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-label">Gross profit</span>
                    <span
                      className="kv-value"
                      style={{
                        color: cart.grossProfit >= 0 ? "var(--success-text)" : "var(--danger-text)",
                      }}
                    >
                      {money(cart.grossProfit, currency)}
                    </span>
                  </div>
                  <div className="kv kv-total">
                    <span className="kv-label">Total</span>
                    <span className="kv-value">{money(cart.total, currency)}</span>
                  </div>
                </div>

                <Field label="Payment method">
                  <select
                    className="select"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Note" hint="Optional — table number, server, or a comment.">
                  <input
                    className="input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Table 4"
                  />
                </Field>

                <FormError message={error} />

                <button
                  className="btn btn-primary w-full"
                  onClick={save}
                  disabled={saving || cart.items.length === 0}
                >
                  {saving ? "Saving…" : `Save sale · ${money(cart.total, currency)}`}
                </button>
                <p className="text-xs muted text-center">
                  Saving reduces bar stock and updates today's figures.
                </p>
              </div>
            )}
          </Card>

          <Card title="Recent Sales">
            {recent.length === 0 ? (
              <EmptyState
                icon={<Receipt size={22} />}
                title="Nothing sold yet"
                description="Completed sales show up here."
              />
            ) : (
              <ul className="space-y-2.5">
                {recent.map((sale) => (
                  <li key={sale.id} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                        {sale.reference}
                      </p>
                      <p className="text-xs muted">
                        {plural(sale.items.length, "item")} · {sale.paymentMethod} ·{" "}
                        {timeShort(barSaleDate(sale))}
                      </p>
                    </div>
                    <span className="text-sm font-semibold num" style={{ color: "var(--text)" }}>
                      {money(sale.total, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
