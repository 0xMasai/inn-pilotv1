/**
 * Live bar data — products, sales and transfers — shared by all four bar
 * pages so they never show different stock numbers from one another.
 */
import { useEffect, useState } from "react";
import { limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { COLLECTIONS } from "../../lib/collections";
import { hotelCollection } from "../../lib/hotelScope";
import {
  toBarProduct,
  toBarSale,
  toBarTransfer,
  type BarProduct,
  type BarSale,
  type BarTransfer,
} from "../../lib/bar";

/** Recent history is enough for these screens; Reports reads the full range. */
const HISTORY_LIMIT = 200;

export interface BarData {
  products: BarProduct[];
  sales: BarSale[];
  transfers: BarTransfer[];
  loading: boolean;
}

export function useBarData(hotelId: string | null): BarData {
  const [products, setProducts] = useState<BarProduct[]>([]);
  const [sales, setSales] = useState<BarSale[]>([]);
  const [transfers, setTransfers] = useState<BarTransfer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hotelId) return;
    setLoading(true);

    const unsubProducts = onSnapshot(
      hotelCollection(hotelId, COLLECTIONS.BAR_PRODUCTS),
      (snap) => {
        setProducts(
          snap.docs
            .map((d) => toBarProduct(d.id, d.data() as Record<string, unknown>))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
        setLoading(false);
      },
      (err) => {
        console.error("Failed to read bar products:", err);
        setLoading(false);
      }
    );

    // Ordering server-side keeps the newest sales first without pulling the
    // whole history into the browser to sort it.
    const unsubSales = onSnapshot(
      query(
        hotelCollection(hotelId, COLLECTIONS.BAR_SALES),
        orderBy("createdAt", "desc"),
        limit(HISTORY_LIMIT)
      ),
      (snap) => setSales(snap.docs.map((d) => toBarSale(d.id, d.data() as Record<string, unknown>))),
      (err) => console.error("Failed to read bar sales:", err)
    );

    const unsubTransfers = onSnapshot(
      query(
        hotelCollection(hotelId, COLLECTIONS.BAR_TRANSFERS),
        orderBy("createdAt", "desc"),
        limit(HISTORY_LIMIT)
      ),
      (snap) =>
        setTransfers(snap.docs.map((d) => toBarTransfer(d.id, d.data() as Record<string, unknown>))),
      (err) => console.error("Failed to read bar transfers:", err)
    );

    return () => {
      unsubProducts();
      unsubSales();
      unsubTransfers();
    };
  }, [hotelId]);

  return { products, sales, transfers, loading };
}
