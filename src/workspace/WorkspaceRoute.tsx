/**
 * Route gates for the workspace model.
 *
 * <WorkspaceRoute> guards the dashboard: no workspace, no dashboard — the
 * visitor is sent to the staff entry at /staff to open or create one. Guests
 * never hold a workspace id, so they can never reach it. <HomeRoute> is the
 * reverse at /staff: a returning hotel goes straight back to work.
 */
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { WifiOff } from "lucide-react";
import { useWorkspace } from "./workspaceContext";

function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center gap-3"
      style={{ background: "var(--app-bg)", color: "var(--text-muted)" }}
    >
      <div
        className="w-8 h-8 rounded-full animate-spin"
        style={{ border: "2px solid var(--border)", borderTopColor: "var(--primary)" }}
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function WorkspaceUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-6"
      style={{ background: "var(--app-bg)" }}
    >
      <div className="w-full max-w-md card p-8 text-center">
        <div
          className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center mb-4"
          style={{ background: "var(--warning-soft)", color: "var(--warning-text)" }}
        >
          <WifiOff size={22} />
        </div>
        <h1 className="text-lg font-semibold mb-2">We couldn't open your workspace</h1>
        <p className="text-sm muted mb-6">
          InnPilot couldn't reach the server. Check your internet connection and try again —
          your hotel's data is safe.
        </p>
        <button className="btn btn-primary w-full" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

export function WorkspaceRoute({ children }: { children: ReactNode }) {
  const { status, retry } = useWorkspace();

  if (status === "loading") return <FullScreenSpinner label="Opening your workspace…" />;
  if (status === "unavailable") return <WorkspaceUnavailable onRetry={retry} />;
  if (status === "none") return <Navigate to="/staff" replace />;
  return <>{children}</>;
}

export function HomeRoute({ children }: { children: ReactNode }) {
  const { status, retry } = useWorkspace();

  if (status === "loading") return <FullScreenSpinner label="Loading…" />;
  if (status === "unavailable") return <WorkspaceUnavailable onRetry={retry} />;
  if (status === "ready") return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
