/**
 * Bar Products — the catalogue and its stock position.
 *
 * Archive rather than delete: past sales reference products by id, so a
 * hard delete would break best-seller reporting for every prior period.
 */
import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Package,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { useBarContext } from "./BarLayout";
import {
  BAR_CATEGORIES,
  BAR_UNITS,
  createProduct,
  productHealth,
  setProductArchived,
  STOCK_BADGE,
  updateProduct,
  type BarProduct,
  type ProductInput,
} from "../../lib/bar";
import { money, num, plural } from "../../lib/format";
import type { StockStatus } from "../../lib/metrics";
import {
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  FormError,
  Modal,
  PageHeader,
  TableSkeleton,
  useToast,
} from "../../components/ui";

const BLANK: ProductInput = {
  name: "",
  category: "Beer",
  unit: "Bottle",
  costPrice: 0,
  sellingPrice: 0,
  barStock: 0,
  storeStock: 0,
  reorderLevel: 0,
};

type StatusFilter = "All" | StockStatus;

export default function BarProducts() {
  const { products, loading, hotelId, currency } = useBarContext();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [status, setStatus] = useState<StatusFilter>("All");
  const [showArchived, setShowArchived] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BarProduct | null>(null);
  const [form, setForm] = useState<ProductInput>(BLANK);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [archiveTarget, setArchiveTarget] = useState<BarProduct | null>(null);
  const [archiving, setArchiving] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => p.archived === showArchived)
      .map((p) => ({ product: p, health: productHealth(p) }))
      .filter(({ product, health }) => {
        if (q && !product.name.toLowerCase().includes(q) && !product.category.toLowerCase().includes(q)) {
          return false;
        }
        if (category !== "All" && product.category !== category) return false;
        if (status !== "All" && health.status !== status) return false;
        return true;
      });
  }, [products, search, category, status, showArchived]);

  const openCreate = () => {
    setEditing(null);
    setForm(BLANK);
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = (product: BarProduct) => {
    setEditing(product);
    setForm({
      name: product.name,
      category: product.category,
      unit: product.unit,
      costPrice: product.costPrice,
      sellingPrice: product.sellingPrice,
      barStock: product.barStock,
      storeStock: product.storeStock,
      reorderLevel: product.reorderLevel,
    });
    setFormError("");
    setFormOpen(true);
  };

  const submit = async () => {
    if (!hotelId) return setFormError("No workspace is open. Reload the page and try again.");
    setSaving(true);
    setFormError("");
    const result = editing
      ? await updateProduct(hotelId, editing.id, form, products)
      : await createProduct(hotelId, form, products);
    setSaving(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    toast.success(editing ? `${form.name} updated` : `${form.name} added to the bar`);
    setFormOpen(false);
  };

  const confirmArchive = async () => {
    if (!archiveTarget || !hotelId) return;
    setArchiving(true);
    const result = await setProductArchived(hotelId, archiveTarget, !archiveTarget.archived);
    setArchiving(false);
    if (result.ok) {
      toast.success(
        archiveTarget.archived
          ? `${archiveTarget.name} restored`
          : `${archiveTarget.name} archived`
      );
      setArchiveTarget(null);
    } else {
      toast.error(result.error);
      setArchiveTarget(null);
    }
  };

  const setNumber = (key: keyof ProductInput, value: string) =>
    setForm((f) => ({ ...f, [key]: value === "" ? 0 : Math.max(0, Number(value) || 0) }));

  const margin = form.sellingPrice - form.costPrice;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        subtitle={`${plural(products.filter((p) => !p.archived).length, "active product")} in the bar catalogue`}
        actions={
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} /> Add Product
          </button>
        }
      />

      <div className="filter-bar">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="search-wrap">
            <Search size={16} />
            <input
              className="input"
              aria-label="Search products"
              placeholder="Search name or category…"
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
            <option value="All">All categories</option>
            {BAR_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Stock status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="All">All stock levels</option>
            <option value="Good">Good</option>
            <option value="Low">Low</option>
            <option value="Critical">Critical</option>
          </select>
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
        <p className="mt-3 text-sm muted">
          Showing <strong style={{ color: "var(--text)" }}>{rows.length}</strong>{" "}
          {showArchived ? "archived" : "active"} product{rows.length === 1 ? "" : "s"}
        </p>
      </div>

      <Card bodyClassName="">
        <div className="table-wrap" style={{ border: "none", borderRadius: "var(--r-lg)" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Unit</th>
                <th className="num">Cost</th>
                <th className="num">Selling</th>
                <th className="num">Margin</th>
                <th className="num">Bar</th>
                <th className="num">Store</th>
                <th className="num">Reorder</th>
                <th>Status</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton rows={6} columns={11} />
              ) : rows.length ? (
                rows.map(({ product, health }) => (
                  <tr key={product.id}>
                    <td className="font-medium" style={{ color: "var(--text)" }}>
                      {product.name}
                    </td>
                    <td>
                      <span className="badge badge-neutral badge-plain">{product.category}</span>
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>{product.unit}</td>
                    <td className="num">{money(product.costPrice, currency)}</td>
                    <td className="num">{money(product.sellingPrice, currency)}</td>
                    <td className="num" style={{ color: health.margin >= 0 ? "var(--success-text)" : "var(--danger-text)" }}>
                      {money(health.margin, currency)}
                      {health.marginPercent !== null && (
                        <span className="muted text-xs ml-1">
                          {Math.round(health.marginPercent)}%
                        </span>
                      )}
                    </td>
                    <td className="num font-semibold">{num(product.barStock)}</td>
                    <td className="num" style={{ color: "var(--text-secondary)" }}>
                      {num(product.storeStock)}
                    </td>
                    <td className="num" style={{ color: "var(--text-secondary)" }}>
                      {num(product.reorderLevel)}
                    </td>
                    <td>
                      <span className={`badge ${STOCK_BADGE[health.status]}`}>{health.status}</span>
                    </td>
                    <td>
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(product)}
                          title={`Edit ${product.name}`}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setArchiveTarget(product)}
                          title={product.archived ? "Restore product" : "Archive product"}
                        >
                          {product.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={11}>
                    <EmptyState
                      icon={<Package size={24} />}
                      title={showArchived ? "No archived products" : "No products yet"}
                      description={
                        products.length
                          ? "Nothing matches your current filters."
                          : "Add the drinks and snacks your bar sells, then transfer stock in from the main store."
                      }
                      action={
                        !products.length ? (
                          <button className="btn btn-primary btn-sm" onClick={openCreate}>
                            <Plus size={15} /> Add your first product
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

      {/* ADD / EDIT */}
      <Modal
        open={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editing ? `Edit ${editing.name}` : "Add Product"}
        description={
          editing
            ? "Changes apply to future sales; past sales keep the price they were sold at."
            : "Stock you enter here becomes the opening balance."
        }
        width="lg"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add product"}
            </button>
          </>
        }
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <FormError message={formError} />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-3">
              <Field label="Product name" required>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Nile Special 500ml"
                  autoFocus
                />
              </Field>
            </div>

            <Field label="Category">
              <select
                className="select"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              >
                {BAR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Unit" required>
              <select
                className="select"
                value={form.unit}
                onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              >
                {BAR_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Reorder level"
              hint="Flagged as Low at this level, Critical at half of it."
            >
              <input
                type="number"
                min={0}
                className="input"
                value={form.reorderLevel || ""}
                onChange={(e) => setNumber("reorderLevel", e.target.value)}
                placeholder="0"
              />
            </Field>

            <Field label={`Cost price (${currency})`} required>
              <input
                type="number"
                min={0}
                className="input"
                value={form.costPrice || ""}
                onChange={(e) => setNumber("costPrice", e.target.value)}
                placeholder="0"
              />
            </Field>

            <Field label={`Selling price (${currency})`} required>
              <input
                type="number"
                min={0}
                className="input"
                value={form.sellingPrice || ""}
                onChange={(e) => setNumber("sellingPrice", e.target.value)}
                placeholder="0"
              />
            </Field>

            <Field label="Margin per unit">
              <div
                className="input flex items-center font-semibold"
                style={{
                  background: "var(--surface-muted)",
                  color: margin >= 0 ? "var(--success-text)" : "var(--danger-text)",
                }}
                aria-live="polite"
              >
                {money(margin, currency)}
                {form.sellingPrice > 0 && (
                  <span className="muted text-xs ml-2 font-normal">
                    {Math.round((margin / form.sellingPrice) * 100)}%
                  </span>
                )}
              </div>
            </Field>

            <Field
              label="Stock at bar"
              hint={editing ? "Corrects the counted balance." : "Units ready to sell."}
            >
              <input
                type="number"
                min={0}
                className="input"
                value={form.barStock || ""}
                onChange={(e) => setNumber("barStock", e.target.value)}
                placeholder="0"
              />
            </Field>

            <Field label="Stock in main store" hint="Transferred to the bar as needed.">
              <input
                type="number"
                min={0}
                className="input"
                value={form.storeStock || ""}
                onChange={(e) => setNumber("storeStock", e.target.value)}
                placeholder="0"
              />
            </Field>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!archiveTarget}
        busy={archiving}
        title={archiveTarget?.archived ? "Restore product?" : "Archive product?"}
        message={
          archiveTarget?.archived
            ? `${archiveTarget?.name} will reappear in the catalogue and can be sold again.`
            : `${archiveTarget?.name} will be hidden from the POS and product list. Past sales and reports keep it, and you can restore it at any time.`
        }
        confirmLabel={archiveTarget?.archived ? "Restore" : "Archive"}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
}
