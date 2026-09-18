// AppShell — the frame every module renders inside.
//
// Modules mount through nested routes (<Outlet/>) and the sidebar is
// NavLink-based, so every screen is deep-linkable and survives a refresh.
// The nav is a flat list of modules: an owner should never have to
// remember which group a screen lives under.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Beer,
  BedDouble,
  Check,
  CircleParking,
  Copy,
  DoorOpen,
  LayoutDashboard,
  Menu,
  Receipt,
  Settings,
  Utensils,
  FileBarChart,
  MessagesSquare,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Tippy from "@tippyjs/react";
import "tippy.js/dist/tippy.css";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { Modal, useToast } from "./components/ui";
import { useWorkspace } from "./workspace/workspaceContext";
import { useHotelProfile } from "./lib/hotelProfile";
import innpilotMark from "./assets/brand/innpilot-mark.png";

interface NavItem {
  icon: ReactNode;
  label: string;
  to: string;
  end?: boolean;
}

/** The modules, in the order an owner works through their day. */
const NAV: NavItem[] = [
  { icon: <LayoutDashboard size={19} />, label: "Dashboard", to: "/dashboard", end: true },
  { icon: <MessagesSquare size={19} />, label: "Inbox", to: "/dashboard/inbox" },
  { icon: <BedDouble size={19} />, label: "Accommodation", to: "/dashboard/accommodation" },
  { icon: <Utensils size={19} />, label: "Restaurant", to: "/dashboard/restaurant" },
  { icon: <Beer size={19} />, label: "Bar", to: "/dashboard/bar" },
  { icon: <CircleParking size={19} />, label: "Parking", to: "/dashboard/parking" },
  { icon: <Receipt size={19} />, label: "Expenses", to: "/dashboard/expenses" },
  { icon: <FileBarChart size={19} />, label: "Reports", to: "/dashboard/reports" },
  { icon: <Settings size={19} />, label: "Settings", to: "/dashboard/settings" },
];

/**
 * Header copy per route. Sub-routes fall back to their parent module by
 * longest-prefix match, so /dashboard/bar/products still reads "Bar".
 */
const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": { title: "Dashboard", subtitle: "Today's money, at a glance" },
  "/dashboard/inbox": { title: "Inbox", subtitle: "Guest conversations from every channel" },
  "/dashboard/accommodation": { title: "Accommodation", subtitle: "Rooms, bookings and occupancy" },
  "/dashboard/restaurant": { title: "Restaurant", subtitle: "Orders and dining revenue" },
  "/dashboard/bar": { title: "Bar", subtitle: "Sales, products and stock" },
  "/dashboard/parking": { title: "Parking", subtitle: "Vehicles on the lot and parking income" },
  "/dashboard/expenses": { title: "Expenses", subtitle: "What the hotel is spending" },
  "/dashboard/reports": { title: "Reports", subtitle: "Daily, weekly and monthly performance" },
  "/dashboard/settings": { title: "Settings", subtitle: "Hotel profile and activity" },
};

function metaFor(pathname: string) {
  const match = Object.keys(PAGE_META)
    .filter((path) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PAGE_META[match] : { title: "InnPilot", subtitle: "" };
}

function SidebarContent({
  collapsed,
  hotelName,
  hotelLocation,
  onNavigate,
  onToggleCollapse,
  onLeave,
}: {
  collapsed: boolean;
  hotelName: string;
  hotelLocation: string;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      <div
        className={`flex items-center h-16 flex-none ${
          collapsed ? "justify-center px-2" : "justify-between px-5"
        }`}
        style={{ borderBottom: "1px solid var(--rail-border)" }}
      >
        {collapsed ? (
          <img src={innpilotMark} alt="InnPilot" className="w-8 h-8 object-contain" />
        ) : (
          <>
            <div className="flex items-center gap-2.5 min-w-0">
              <img src={innpilotMark} alt="InnPilot" className="w-9 h-9 flex-none object-contain" />
              <div className="leading-tight min-w-0">
                <p className="text-[15px] font-semibold text-white tracking-tight truncate">
                  InnPilot
                </p>
                <p className="text-[11px] truncate" style={{ color: "var(--rail-text-muted)" }}>
                  {hotelName || "Hotel operations"}
                </p>
              </div>
            </div>
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className="p-2 rounded-lg hover:bg-white/10 transition flex-none"
                style={{ color: "var(--rail-text-muted)" }}
                aria-label="Collapse sidebar"
              >
                <Menu size={18} />
              </button>
            )}
          </>
        )}
      </div>

      {collapsed && onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          className="mx-auto mt-3 p-2 rounded-lg hover:bg-white/10 transition"
          style={{ color: "var(--rail-text-muted)" }}
          aria-label="Expand sidebar"
        >
          <Menu size={18} />
        </button>
      )}

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV.map((item) => (
          <Tippy
            key={item.to}
            content={item.label}
            placement="right"
            disabled={!collapsed}
          >
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                `relative flex items-center w-full px-3 py-2.5 rounded-lg transition-all text-[14.5px] ${
                  collapsed ? "justify-center" : "gap-3"
                } ${
                  isActive
                    ? "bg-[var(--rail-active)] text-white font-semibold"
                    : "hover:bg-white/5 hover:text-white"
                }`
              }
              style={({ isActive }) => (isActive ? undefined : { color: "var(--rail-text)" })}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full"
                      style={{ background: "var(--brand-cyan)" }}
                    />
                  )}
                  <span style={isActive ? { color: "var(--brand-cyan)" } : undefined}>
                    {item.icon}
                  </span>
                  {!collapsed && <span>{item.label}</span>}
                </>
              )}
            </NavLink>
          </Tippy>
        ))}
      </nav>

      {/* The active workspace. No accounts exist, so this is the hotel, not a person. */}
      <div className="p-3 flex-none" style={{ borderTop: "1px solid var(--rail-border)" }}>
        <NavLink
          to="/dashboard/settings"
          onClick={onNavigate}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition w-full ${
            collapsed ? "justify-center" : ""
          }`}
          style={{ color: "var(--rail-text)" }}
          aria-label="Hotel settings"
        >
          <span
            className="w-8 h-8 rounded-lg flex-none flex items-center justify-center text-[13px] font-bold text-white"
            style={{ background: "var(--rail-active)" }}
            aria-hidden
          >
            {(hotelName || "H").slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="flex-1 text-left leading-tight min-w-0">
              <span className="block text-sm font-semibold text-white truncate">
                {hotelName || "Your hotel"}
              </span>
              <span className="block text-xs truncate" style={{ color: "var(--rail-text-muted)" }}>
                {hotelLocation || "Workspace settings"}
              </span>
            </span>
          )}
        </NavLink>
        <Tippy content="Leave workspace" placement="right" disabled={!collapsed}>
          <button
            type="button"
            onClick={onLeave}
            className={`mt-1 flex items-center w-full px-3 py-2 rounded-lg hover:bg-white/5 hover:text-white transition text-[13.5px] ${
              collapsed ? "justify-center" : "gap-3"
            }`}
            style={{ color: "var(--rail-text-muted)" }}
            aria-label="Leave workspace"
          >
            <DoorOpen size={17} />
            {!collapsed && <span>Leave workspace</span>}
          </button>
        </Tippy>
      </div>
    </>
  );
}

/**
 * There are no accounts, so leaving only makes this browser forget the
 * hotel. The workspace ID is the one way back in: show it before it goes.
 */
function LeaveWorkspaceDialog({
  open,
  hotelId,
  onCancel,
  onLeave,
}: {
  open: boolean;
  hotelId: string | null;
  onCancel: () => void;
  onLeave: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!hotelId) return;
    try {
      await navigator.clipboard.writeText(hotelId);
      setCopied(true);
      toast.success("Workspace ID copied");
    } catch {
      toast.error("Couldn't copy automatically. Select the ID and copy it instead.");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Leave this workspace?"
      width="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onLeave}>
            Leave workspace
          </button>
        </>
      }
    >
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        This browser will forget your hotel. Nothing is deleted. To open it again, paste this
        workspace ID on the staff page:
      </p>
      <div className="flex items-center gap-2 mt-4">
        <code
          className="flex-1 min-w-0 truncate text-xs rounded-md px-2.5 py-2 select-all"
          style={{ background: "var(--surface-muted)", color: "var(--text)" }}
        >
          {hotelId ?? "—"}
        </code>
        <button
          type="button"
          className="btn btn-secondary btn-sm shrink-0"
          onClick={copy}
          aria-label="Copy workspace ID"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </Modal>
  );
}

const EXPANDED = 260;
const COLLAPSED = 76;

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { hotelId, leaveWorkspace } = useWorkspace();
  const { profile } = useHotelProfile(hotelId);
  const mainRef = useRef<HTMLElement>(null);

  // A route change should start the new page at the top, not wherever the
  // previous one was scrolled to.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setMobileOpen(false);
  }, [location.pathname]);

  const meta = metaFor(location.pathname);

  const confirmLeave = () => {
    setLeaving(false);
    leaveWorkspace();
    navigate("/staff", { replace: true });
  };

  return (
    <div
      className="flex h-screen w-screen overflow-hidden"
      style={{ background: "var(--app-bg)" }}
    >
      {/* DESKTOP RAIL */}
      <motion.aside
        animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        className="hidden md:flex flex-col fixed h-full z-30"
        style={{ background: "var(--rail)", borderRight: "1px solid var(--rail-border)" }}
      >
        <SidebarContent
          collapsed={collapsed}
          hotelName={profile.name}
          hotelLocation={profile.location}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onLeave={() => setLeaving(true)}
        />
      </motion.aside>

      {/* MOBILE DRAWER */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900/50 z-40 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 320, damping: 34 }}
              className="fixed top-0 left-0 h-full w-[264px] z-50 flex flex-col md:hidden"
              style={{ background: "var(--rail)" }}
            >
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-4 right-3 p-2 rounded-lg hover:bg-white/10 z-10"
                style={{ color: "var(--rail-text-muted)" }}
                aria-label="Close navigation"
              >
                <X size={18} />
              </button>
              <SidebarContent
                collapsed={false}
                hotelName={profile.name}
                hotelLocation={profile.location}
                onNavigate={() => setMobileOpen(false)}
                onLeave={() => {
                  setMobileOpen(false);
                  setLeaving(true);
                }}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* MAIN COLUMN */}
      <div
        className="flex flex-col flex-1 min-h-0 min-w-0 md:ml-[var(--rail-offset)] transition-[margin] duration-300"
        style={{ "--rail-offset": `${collapsed ? COLLAPSED : EXPANDED}px` } as React.CSSProperties}
      >
        <header
          className="flex items-center gap-3 px-4 sm:px-6 h-16 flex-none sticky top-0 z-20 bg-white/85 backdrop-blur-md"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <button
            className="md:hidden icon-btn"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>

          <div className="min-w-0 flex-1">
            <h1
              className="text-[15px] font-semibold truncate leading-tight"
              style={{ color: "var(--text)" }}
            >
              {meta.title}
            </h1>
            <p className="text-xs muted truncate">{meta.subtitle}</p>
          </div>

          {profile.name && (
            <span className="hidden sm:inline text-sm font-medium truncate max-w-[220px]" style={{ color: "var(--text-secondary)" }}>
              {profile.name}
            </span>
          )}
        </header>

        <main ref={mainRef} className="flex-1 min-h-0 overflow-auto">
          <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            <Outlet />
          </div>
          <footer className="px-6 py-5 text-xs muted text-center">
            © {new Date().getFullYear()} InnPilot · Built by Masai Labs
          </footer>
        </main>
      </div>

      <LeaveWorkspaceDialog
        open={leaving}
        hotelId={hotelId}
        onCancel={() => setLeaving(false)}
        onLeave={confirmLeave}
      />
    </div>
  );
}
