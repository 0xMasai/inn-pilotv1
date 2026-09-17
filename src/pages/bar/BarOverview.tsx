/**
 * Bar Overview — today's trading position for the bar alone.
 *
 * Deliberately narrower than the main Dashboard: a bar supervisor cares
 * about takings, margin and whether the shelves are about to run dry, not
 * about hotel-wide profit.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Banknote,
  Beer,
  Boxes,
  PackageX,
  Receipt,
  TrendingUp,
} from "lucide-react";
import { useBarContext } from "./BarLayout";
import { productHealth, STOCK_BADGE } from "../../lib/bar";
import {
  barSaleDate,
  bestSellingProducts,
  getRange,
  inRange,
} from "../../lib/metrics";
import { money, moneyCompact, num, plural, timeShort } from "../../lib/format";
import { Card, EmptyState, PageHeader, StatCard, StatGrid } from "../../components/ui";

export default function BarOverview() {
  const { products, sales, loading, currency } = useBarContext();

  const today = useMemo(() => getRange("today"), []);

  const stats = useMemo(() => {
    const todaySales = sales.filter((s) => inRange(barSaleDate(s), today));
    const revenue = todaySales.reduce((sum, s) => sum + s.total, 0);
    const cost = todaySales.reduce((sum, s) => sum + s.cost, 0);

    const active = products.filter((p) => !p.archived);
    let stockValue = 0;
    let low = 0;
    let critical = 0;
    for (const p of active) {
      const health = productHealth(p);
      stockValue += health.stockValue;
      if (health.status === "Critical") critical += 1;
      else if (health.status === "Low") low += 1;
    }

    return {
      revenue,
      cost,
      grossProfit: revenue - cost,
      margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
      transactions: todaySales.length,
      stockValue,
      low,
      critical,
      activeCount: active.length,
    };
  }, [sales, products, today]);

  const bestSellers = useMemo(
    () => bestSellingProducts(sales, getRange("week"), 5),
    [sales]
  );

  const needsAttention = useMemo(
    () =>
      products
        .filter((p) => !p.archived)
        .map((p) => ({ product: p, health: productHealth(p) }))
        .filter((row) => row.health.status !== "Good")
        .sort((a, b) => a.product.barStock - b.product.barStock)
        .slice(0, 6),
    [products]
  );

  const recentSales = sales.slice(0, 6);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bar Overview"
        subtitle="Today's trading, stock position and best sellers"
        actions={
          <>
            <Link to="/dashboard/bar/transfers" className="btn btn-secondary">
              <Boxes size={16} /> Transfer stock
            </Link>
            <Link to="/dashboard/bar/sales" className="btn btn-primary">
              <Beer size={16} /> New sale
            </Link>
          </>
        }
      />

      <StatGrid>
        <StatCard
          index={0}
          loading={loading}
          label="Today's Sales"
          value={money(stats.revenue, currency)}
          icon={<Banknote size={19} />}
          tone="success"
          hint={plural(stats.transactions, "transaction")}
        />
        <StatCard
          index={1}
          loading={loading}
          label="Transactions"
          value={num(stats.transactions)}
          icon={<Receipt size={19} />}
          tone="primary"
          hint={
            stats.transactions > 0
              ? `${money(stats.revenue / stats.transactions, currency)} average`
              : "No sales yet today"
          }
        />
        <StatCard
          index={2}
          loading={loading}
          label="Gross Profit"
          value={money(stats.grossProfit, currency)}
          icon={<TrendingUp size={19} />}
          tone={stats.grossProfit >= 0 ? "success" : "danger"}
          hint={stats.revenue > 0 ? `${Math.round(stats.margin)}% margin` : "Sales less cost of goods"}
        />
        <StatCard
          index={3}
          loading={loading}
          label="Stock Value"
          value={money(stats.stockValue, currency)}
          icon={<Boxes size={19} />}
          tone="purple"
          hint={`${plural(stats.activeCount, "product")} at cost`}
        />
      </StatGrid>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card
          className="lg:col-span-2"
          title="Recent Sales"
          action={
            <Link
              to="/dashboard/bar/sales"
              className="text-xs font-semibold inline-flex items-center gap-1"
              style={{ color: "var(--primary)" }}
            >
              Open POS <ArrowRight size={13} />
            </Link>
          }
          bodyClassName=""
        >
          {loading ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 40 }} />
              ))}
            </div>
          ) : recentSales.length === 0 ? (
            <EmptyState
              icon={<Receipt size={24} />}
              title="No sales recorded"
              description="Ring up a sale from the POS and it will appear here instantly."
              action={
                <Link to="/dashboard/bar/sales" className="btn btn-primary btn-sm">
                  <Beer size={15} /> New sale
                </Link>
              }
            />
          ) : (
            <ul>
              {recentSales.map((sale, i) => (
                <li
                  key={sale.id}
                  className="flex items-center gap-3 px-5 py-3"
                  style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
                >
                  <span
                    className="w-9 h-9 rounded-lg flex-none flex items-center justify-center"
                    style={{ background: "#7c3aed14", color: "#7c3aed" }}
                    aria-hidden
                  >
                    <Beer size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                      {sale.items.map((it) => `${it.quantity}× ${it.name}`).join(", ") ||
                        sale.reference}
                    </p>
                    <p className="text-xs muted">
                      {sale.reference} · {sale.paymentMethod} · {timeShort(barSaleDate(sale))}
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

        <div className="space-y-5">
          <Card
            title="Needs Restocking"
            action={
              <span className="text-xs muted">
                {stats.critical + stats.low > 0
                  ? `${stats.critical + stats.low} item(s)`
                  : "All good"}
              </span>
            }
          >
            {needsAttention.length === 0 ? (
              <EmptyState
                icon={<PackageX size={22} />}
                title="Stock is healthy"
                description="Every product is above its reorder level."
              />
            ) : (
              <ul className="space-y-3">
                {needsAttention.map(({ product, health }) => (
                  <li key={product.id} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                        {product.name}
                      </p>
                      <p className="text-xs muted">
                        {product.barStock} at bar · {product.storeStock} in store
                      </p>
                    </div>
                    <span className={`badge ${STOCK_BADGE[health.status]}`}>{health.status}</span>
                  </li>
                ))}
                <li className="pt-1">
                  <Link to="/dashboard/bar/transfers" className="btn btn-secondary btn-sm w-full">
                    <Boxes size={14} /> Transfer from store
                  </Link>
                </li>
              </ul>
            )}
          </Card>

          <Card title="Best Sellers" action={<span className="text-xs muted">This week</span>}>
            {bestSellers.length === 0 ? (
              <EmptyState
                icon={<TrendingUp size={22} />}
                title="No sales this week"
                description="Best sellers rank by units sold over the last seven days."
              />
            ) : (
              <ul className="space-y-3">
                {bestSellers.map((row, i) => (
                  <li key={row.productId} className="flex items-center gap-3">
                    <span
                      className="w-6 h-6 rounded-md flex-none flex items-center justify-center text-xs font-bold"
                      style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                        {row.name}
                      </p>
                      <p className="text-xs muted">{plural(row.quantity, "unit")} sold</p>
                    </div>
                    <span className="text-sm num" style={{ color: "var(--text-secondary)" }}>
                      {moneyCompact(row.revenue, currency)}
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
