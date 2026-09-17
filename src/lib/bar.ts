/**
 * Bar module service layer — products, sales and store→bar transfers.
 *
 * Every stock movement runs inside a Firestore transaction. That is not
 * defensiveness: two staff can ring up the last crate at the same moment,
 * and a read-then-write outside a transaction would let both succeed and
 * push stock negative. The transaction re-reads each product and refuses
 * the whole operation if any line no longer has the units — so a sale is
 * all-or-nothing and inventory can never go below zero.
 */
import {
  addDoc,
  collection,
  doc,
  getDocs,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { COLLECTIONS, type PaymentMethod } from "./collections";
import { hotelCollection, hotelDoc, HOTELS_COLLECTION } from "./hotelScope";
import { logAction } from "./audit";
import { fail, ok, errorMessage, type ServiceResult } from "./serviceResult";
import { stockStatusOf, type StockStatus } from "./metrics";

export const BAR_CATEGORIES = [
  "Beer",
  "Spirits",
  "Wine",
  "Soft Drinks",
  "Water",
  "Energy Drinks",
  "Snacks",
  "Other",
] as const;

export const BAR_UNITS = ["Bottle", "Can", "Crate", "Glass", "Shot", "Piece", "Pack"] as const;

/** hotels/{hotelId}/barProducts/{id} */
export interface BarProduct {
  id: string;
  name: string;
  category: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  /** Sellable units on the bar floor. Sales deduct from here. */
  barStock: number;
  /** Units held in the main store, awaiting transfer to the bar. */
  storeStock: number;
  reorderLevel: number;
  archived: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
  userId?: string;
}

/** hotels/{hotelId}/barSales/{id} */
export interface BarSaleItem {
  productId: string;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  /** Cost snapshot at time of sale, so historic margin survives a price change. */
  costPrice: number;
  lineTotal: number;
}

export interface BarSale {
  id: string;
  reference: string;
  items: BarSaleItem[];
  total: number;
  cost: number;
  grossProfit: number;
  paymentMethod: PaymentMethod;
  note?: string;
  createdAt?: unknown;
  userId?: string;
  userEmail?: string;
}

/** hotels/{hotelId}/barTransfers/{id} */
export interface BarTransfer {
  id: string;
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  /** Store balance after the move — the audit trail's "what it became". */
  storeStockAfter: number;
  barStockAfter: number;
  note?: string;
  createdAt?: unknown;
  userId?: string;
  userEmail?: string;
}

// ---------- Reading ----------

export function toBarProduct(id: string, data: Record<string, unknown>): BarProduct {
  return {
    id,
    name: String(data.name ?? ""),
    category: String(data.category ?? "Other"),
    unit: String(data.unit ?? "Piece"),
    costPrice: Number(data.costPrice) || 0,
    sellingPrice: Number(data.sellingPrice) || 0,
    barStock: Number(data.barStock) || 0,
    storeStock: Number(data.storeStock) || 0,
    reorderLevel: Number(data.reorderLevel) || 0,
    archived: data.archived === true,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    userId: typeof data.userId === "string" ? data.userId : undefined,
  };
}

export function toBarSale(id: string, data: Record<string, unknown>): BarSale {
  const items = Array.isArray(data.items) ? (data.items as BarSaleItem[]) : [];
  return {
    id,
    reference: String(data.reference ?? ""),
    items,
    total: Number(data.total) || 0,
    cost: Number(data.cost) || 0,
    grossProfit: Number(data.grossProfit) || 0,
    paymentMethod: (data.paymentMethod as PaymentMethod) ?? "Cash",
    note: typeof data.note === "string" ? data.note : undefined,
    createdAt: data.createdAt,
    userId: typeof data.userId === "string" ? data.userId : undefined,
    userEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
  };
}

export function toBarTransfer(id: string, data: Record<string, unknown>): BarTransfer {
  return {
    id,
    productId: String(data.productId ?? ""),
    productName: String(data.productName ?? ""),
    unit: String(data.unit ?? ""),
    quantity: Number(data.quantity) || 0,
    storeStockAfter: Number(data.storeStockAfter) || 0,
    barStockAfter: Number(data.barStockAfter) || 0,
    note: typeof data.note === "string" ? data.note : undefined,
    createdAt: data.createdAt,
    userId: typeof data.userId === "string" ? data.userId : undefined,
    userEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
  };
}

// ---------- Derived product facts ----------

export interface ProductHealth {
  status: StockStatus;
  /** Selling price minus cost, per unit. */
  margin: number;
  /** Margin as a share of selling price, 0–100. Null when no price is set. */
  marginPercent: number | null;
  /** Cost value of every unit held, bar + store. */
  stockValue: number;
}

export function productHealth(p: BarProduct): ProductHealth {
  const margin = p.sellingPrice - p.costPrice;
  return {
    status: stockStatusOf(p.barStock, p.reorderLevel),
    margin,
    marginPercent: p.sellingPrice > 0 ? (margin / p.sellingPrice) * 100 : null,
    stockValue: (p.barStock + p.storeStock) * p.costPrice,
  };
}

export const STOCK_BADGE: Record<StockStatus, string> = {
  Good: "badge-success",
  Low: "badge-warning",
  Critical: "badge-danger",
};

// ---------- Writing ----------

export interface ProductInput {
  name: string;
  category: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  barStock: number;
  storeStock: number;
  reorderLevel: number;
}

function validateProduct(input: ProductInput): string | null {
  if (!input.name.trim()) return "Enter a product name.";
  if (!input.unit.trim()) return "Choose a unit.";
  if (input.costPrice < 0 || input.sellingPrice < 0) return "Prices cannot be negative.";
  if (input.barStock < 0 || input.storeStock < 0) return "Stock cannot be negative.";
  if (input.reorderLevel < 0) return "Reorder level cannot be negative.";
  if (input.sellingPrice > 0 && input.sellingPrice < input.costPrice) {
    return "Selling price is below cost price — this product would sell at a loss.";
  }
  return null;
}

export async function createProduct(
  hotelId: string,
  input: ProductInput,
  existing: BarProduct[]
): Promise<ServiceResult<{ id: string }>> {
  const error = validateProduct(input);
  if (error) return fail(error);

  const name = input.name.trim();
  if (existing.some((p) => !p.archived && p.name.toLowerCase() === name.toLowerCase())) {
    return fail(`"${name}" is already in your product list.`);
  }

  try {
    const ref = await addDoc(hotelCollection(hotelId, COLLECTIONS.BAR_PRODUCTS), {
      name,
      category: input.category,
      unit: input.unit,
      costPrice: input.costPrice,
      sellingPrice: input.sellingPrice,
      barStock: input.barStock,
      storeStock: input.storeStock,
      reorderLevel: input.reorderLevel,
      archived: false,
      createdAt: serverTimestamp(),
    });
    logAction(hotelId, "Bar product added", "product", ref.id, name);
    return ok({ id: ref.id });
  } catch (err) {
    console.error("Failed to create bar product:", err);
    return fail(errorMessage(err) || "Could not save this product.");
  }
}

export async function updateProduct(
  hotelId: string,
  productId: string,
  input: ProductInput,
  existing: BarProduct[]
): Promise<ServiceResult<null>> {
  const error = validateProduct(input);
  if (error) return fail(error);

  const name = input.name.trim();
  if (
    existing.some(
      (p) => p.id !== productId && !p.archived && p.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return fail(`"${name}" is already in your product list.`);
  }

  try {
    await updateDoc(hotelDoc(hotelId, COLLECTIONS.BAR_PRODUCTS, productId), {
      name,
      category: input.category,
      unit: input.unit,
      costPrice: input.costPrice,
      sellingPrice: input.sellingPrice,
      barStock: input.barStock,
      storeStock: input.storeStock,
      reorderLevel: input.reorderLevel,
      updatedAt: serverTimestamp(),
    });
    logAction(hotelId, "Bar product updated", "product", productId, name);
    return ok(null);
  } catch (err) {
    console.error("Failed to update bar product:", err);
    return fail(errorMessage(err) || "Could not update this product.");
  }
}

/**
 * Archiving, not deleting. Past sales reference this product by id; a hard
 * delete would leave those lines pointing at nothing and silently break
 * best-seller reporting.
 */
export async function setProductArchived(
  hotelId: string,
  product: BarProduct,
  archived: boolean
): Promise<ServiceResult<null>> {
  try {
    await updateDoc(hotelDoc(hotelId, COLLECTIONS.BAR_PRODUCTS, product.id), {
      archived,
      updatedAt: serverTimestamp(),
    });
    logAction(
      hotelId,
      archived ? "Bar product archived" : "Bar product restored",
      "product",
      product.id,
      product.name
    );
    return ok(null);
  } catch (err) {
    console.error("Failed to archive bar product:", err);
    return fail(errorMessage(err) || "Could not archive this product.");
  }
}

// ---------- Sales ----------

export interface CartLine {
  productId: string;
  quantity: number;
}

export function makeReference(prefix: string): string {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()
      : Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

export interface SaleTotals {
  items: BarSaleItem[];
  total: number;
  cost: number;
  grossProfit: number;
}

/**
 * Prices a cart against the current product list. Pure, so the POS can
 * show live totals as the cashier types without touching Firestore.
 */
export function priceCart(lines: CartLine[], products: BarProduct[]): SaleTotals {
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: BarSaleItem[] = [];
  let total = 0;
  let cost = 0;

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product || line.quantity <= 0) continue;
    const lineTotal = product.sellingPrice * line.quantity;
    items.push({
      productId: product.id,
      name: product.name,
      unit: product.unit,
      quantity: line.quantity,
      unitPrice: product.sellingPrice,
      costPrice: product.costPrice,
      lineTotal,
    });
    total += lineTotal;
    cost += product.costPrice * line.quantity;
  }

  return { items, total, cost, grossProfit: total - cost };
}

export interface RecordSaleInput {
  lines: CartLine[];
  paymentMethod: PaymentMethod;
  note?: string;
}

/**
 * Records a sale and deducts bar stock atomically.
 *
 * Reads happen before writes (a Firestore transaction requirement) and
 * every line is re-checked against the freshly-read document, so a
 * quantity that was available when the cashier added it but has since
 * been sold elsewhere fails the whole sale rather than overselling.
 */
export async function recordSale(
  hotelId: string,
  input: RecordSaleInput
): Promise<ServiceResult<{ id: string; reference: string; total: number }>> {
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (!lines.length) return fail("Add at least one product to the sale.");
  if (lines.some((l) => !Number.isInteger(l.quantity))) {
    return fail("Quantities must be whole units.");
  }

  const reference = makeReference("BAR");

  try {
    const saved = await runTransaction(db, async (tx) => {
      const refs = lines.map((l) => hotelDoc(hotelId, COLLECTIONS.BAR_PRODUCTS, l.productId));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));

      const items: BarSaleItem[] = [];
      let total = 0;
      let cost = 0;

      snaps.forEach((snap, i) => {
        const line = lines[i];
        if (!snap.exists()) {
          throw new Error("A product in this sale no longer exists. Refresh and try again.");
        }
        const product = toBarProduct(snap.id, snap.data() as Record<string, unknown>);
        if (product.barStock < line.quantity) {
          throw new Error(
            `Not enough ${product.name} at the bar — ${product.barStock} ${product.unit.toLowerCase()}(s) available, ${line.quantity} requested.`
          );
        }
        const lineTotal = product.sellingPrice * line.quantity;
        items.push({
          productId: product.id,
          name: product.name,
          unit: product.unit,
          quantity: line.quantity,
          unitPrice: product.sellingPrice,
          costPrice: product.costPrice,
          lineTotal,
        });
        total += lineTotal;
        cost += product.costPrice * line.quantity;
        tx.update(refs[i], {
          barStock: product.barStock - line.quantity,
          updatedAt: serverTimestamp(),
        });
      });

      const saleRef = doc(collection(db, HOTELS_COLLECTION, hotelId, COLLECTIONS.BAR_SALES));
      tx.set(saleRef, {
        reference,
        items,
        total,
        cost,
        grossProfit: total - cost,
        paymentMethod: input.paymentMethod,
        note: input.note ?? "",
        createdAt: serverTimestamp(),
      });

      return { id: saleRef.id, total };
    });

    logAction(
      hotelId,
      "Bar sale recorded",
      "sale",
      saved.id,
      `${reference} · ${lines.length} line(s) · ${saved.total.toLocaleString()}`
    );
    return ok({ id: saved.id, reference, total: saved.total });
  } catch (err) {
    console.error("Failed to record bar sale:", err);
    return fail(errorMessage(err) || "Could not record this sale.");
  }
}

// ---------- Stock transfer ----------

export interface TransferInput {
  productId: string;
  quantity: number;
  note?: string;
}

/**
 * Moves units from the main store to the bar.
 *
 * The quantity is checked against the store balance read *inside* the
 * transaction, so two managers transferring the same crate cannot both
 * succeed. Total stock is conserved — this only ever shifts units between
 * two buckets, never creates them.
 */
export async function transferToBar(
  hotelId: string,
  input: TransferInput
): Promise<ServiceResult<{ id: string; storeStockAfter: number; barStockAfter: number }>> {
  if (!input.productId) return fail("Choose a product to transfer.");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return fail("Enter a whole quantity greater than zero.");
  }


  try {
    const result = await runTransaction(db, async (tx) => {
      const productRef = hotelDoc(hotelId, COLLECTIONS.BAR_PRODUCTS, input.productId);
      const snap = await tx.get(productRef);
      if (!snap.exists()) {
        throw new Error("That product no longer exists. Refresh and try again.");
      }

      const product = toBarProduct(snap.id, snap.data() as Record<string, unknown>);
      if (product.storeStock < input.quantity) {
        throw new Error(
          `Only ${product.storeStock} ${product.unit.toLowerCase()}(s) of ${product.name} in the main store.`
        );
      }

      const storeStockAfter = product.storeStock - input.quantity;
      const barStockAfter = product.barStock + input.quantity;

      tx.update(productRef, {
        storeStock: storeStockAfter,
        barStock: barStockAfter,
        updatedAt: serverTimestamp(),
      });

      const transferRef = doc(
        collection(db, HOTELS_COLLECTION, hotelId, COLLECTIONS.BAR_TRANSFERS)
      );
      tx.set(transferRef, {
        productId: product.id,
        productName: product.name,
        unit: product.unit,
        quantity: input.quantity,
        storeStockAfter,
        barStockAfter,
        note: input.note ?? "",
        createdAt: serverTimestamp(),
      });

      return { id: transferRef.id, storeStockAfter, barStockAfter, name: product.name, unit: product.unit };
    });

    logAction(
      hotelId,
      "Stock transferred to bar",
      "transfer",
      result.id,
      `${input.quantity} ${result.unit.toLowerCase()}(s) of ${result.name} · store ${result.storeStockAfter}, bar ${result.barStockAfter}`
    );
    return ok(result);
  } catch (err) {
    console.error("Failed to transfer stock:", err);
    return fail(errorMessage(err) || "Could not complete this transfer.");
  }
}

/** One-shot read of the product list, for callers with no live listener. */
export async function loadProducts(hotelId: string): Promise<BarProduct[]> {
  const snap = await getDocs(hotelCollection(hotelId, COLLECTIONS.BAR_PRODUCTS));
  return snap.docs
    .map((d) => toBarProduct(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => a.name.localeCompare(b.name));
}
