/**
 * Bar module shell.
 *
 * The four bar screens share one data subscription, handed down through
 * the router outlet context. Without this each page would open its own
 * listeners and a stock number could differ between two tabs of the same
 * module.
 */
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { ArrowLeftRight, LayoutGrid, Package, ShoppingCart } from "lucide-react";
import { useWorkspace } from "../../workspace/workspaceContext";
import { useHotelProfile } from "../../lib/hotelProfile";
import { useBarData, type BarData } from "./useBarData";

export interface BarContext extends BarData {
  hotelId: string | null;
  currency: string;
}

const TABS = [
  { to: "/dashboard/bar", label: "Overview", icon: <LayoutGrid size={16} />, end: true },
  { to: "/dashboard/bar/products", label: "Products", icon: <Package size={16} /> },
  { to: "/dashboard/bar/sales", label: "Sales", icon: <ShoppingCart size={16} /> },
  { to: "/dashboard/bar/transfers", label: "Stock Transfer", icon: <ArrowLeftRight size={16} /> },
];

export default function BarLayout() {
  const { hotelId } = useWorkspace();
  const bar = useBarData(hotelId);
  const { profile } = useHotelProfile(hotelId);

  const context: BarContext = { ...bar, hotelId, currency: profile.currency };

  return (
    <div>
      <nav className="subnav" aria-label="Bar sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => `subnav-item ${isActive ? "is-active" : ""}`}
          >
            {tab.icon}
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={context} />
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBarContext(): BarContext {
  return useOutletContext<BarContext>();
}
