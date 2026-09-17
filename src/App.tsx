import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import { ToastProvider } from "./components/ui";
import { WorkspaceProvider } from "./workspace/WorkspaceProvider";
import { HomeRoute, WorkspaceRoute } from "./workspace/WorkspaceRoute";

/**
 * Two experiences (DECISIONS D23):
 *   - the public AI Concierge at "/" (and a hotel's own link, "/c/:publicHotelId");
 *   - the staff PMS at "/staff" and "/dashboard/*", behind a workspace id.
 *
 * Every screen is code-split.
 *
 * A hotel manager on a phone should download the page they're on, not the
 * whole product — the marketing site, the setup wizard and each module are
 * separate bundles fetched only when someone navigates to them.
 */
const LandingPage = lazy(() => import("./pages/home"));
const SetupWizard = lazy(() => import("./pages/onboarding/SetupWizard"));
const ConciergePage = lazy(() => import("./pages/concierge/ConciergePage"));

const AppShell = lazy(() => import("./dashboard"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Inbox = lazy(() => import("./pages/inbox/Inbox"));
const Accommodation = lazy(() => import("./Accommodation"));
const Restaurant = lazy(() => import("./Restaurant"));
const Expenses = lazy(() => import("./Expenses"));
const Parking = lazy(() => import("./pages/Parking"));
const Reports = lazy(() => import("./Reports"));
const SettingsPage = lazy(() => import("./pages/Settings"));

const BarLayout = lazy(() => import("./pages/bar/BarLayout"));
const BarOverview = lazy(() => import("./pages/bar/BarOverview"));
const BarProducts = lazy(() => import("./pages/bar/BarProducts"));
const BarSales = lazy(() => import("./pages/bar/BarSales"));
const BarTransfers = lazy(() => import("./pages/bar/BarTransfers"));

/** Shown while a route's bundle is in flight. */
function RouteFallback() {
  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center gap-3"
      style={{ background: "var(--app-bg)", color: "var(--text-muted)" }}
    >
      <div
        className="w-8 h-8 rounded-full animate-spin"
        style={{
          border: "2px solid var(--border)",
          borderTopColor: "var(--primary)",
        }}
      />
      <p className="text-sm">Loading…</p>
    </div>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <ToastProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* The product: the public AI Concierge. No account, no workspace. */}
            <Route path="/" element={<ConciergePage />} />
            {/* The same concierge on one hotel's own link: its public id, never its workspace id. */}
            <Route path="/c/:publicHotelId" element={<ConciergePage />} />

            {/* Staff: open or create a workspace; a returning hotel goes straight to work. */}
            <Route
              path="/staff"
              element={
                <HomeRoute>
                  <LandingPage />
                </HomeRoute>
              }
            />
            <Route path="/staff/get-started" element={<SetupWizard />} />
            <Route path="/pms" element={<Navigate to="/dashboard" replace />} />
            <Route path="/landing" element={<Navigate to="/staff" replace />} />
            <Route path="/get-started" element={<Navigate to="/staff/get-started" replace />} />

            {/* Retired paths: accounts no longer exist, so bookmarks land somewhere useful. */}
            <Route path="/login" element={<Navigate to="/staff" replace />} />
            <Route path="/signup" element={<Navigate to="/staff/get-started" replace />} />
            <Route path="/book-demo" element={<Navigate to="/staff/get-started" replace />} />
            <Route path="/admin/*" element={<Navigate to="/staff" replace />} />
            <Route path="/super-admin/*" element={<Navigate to="/staff" replace />} />
            <Route path="/profile" element={<Navigate to="/dashboard/settings" replace />} />

            <Route
              path="/dashboard"
              element={
                <WorkspaceRoute>
                  <AppShell />
                </WorkspaceRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="accommodation" element={<Accommodation />} />
              <Route path="restaurant" element={<Restaurant />} />
              <Route path="bar" element={<BarLayout />}>
                <Route index element={<BarOverview />} />
                <Route path="products" element={<BarProducts />} />
                <Route path="sales" element={<BarSales />} />
                <Route path="transfers" element={<BarTransfers />} />
              </Route>
              <Route path="parking" element={<Parking />} />
              <Route path="expenses" element={<Expenses />} />
              <Route path="reports" element={<Reports />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </WorkspaceProvider>
  );
}

export default App;
