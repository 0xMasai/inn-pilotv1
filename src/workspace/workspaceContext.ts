/**
 * Which hotel this browser is working in.
 *
 * InnPilot has no user accounts. A workspace is identified by its hotelId,
 * remembered in localStorage when the hotel is created, and every module
 * reads its data through that id — the same `hotels/{hotelId}/…` paths the
 * app has always used. Only *how the active hotel is chosen* changed.
 *
 * Kept apart from the provider component so the hook can be imported
 * without tripping React Fast Refresh's one-component-per-file rule.
 */
import { createContext, useContext } from "react";

/** localStorage key holding the active workspace's hotelId. */
export const WORKSPACE_STORAGE_KEY = "innpilot_hotel";

/**
 * - `loading`     — a stored id is being checked against Firestore
 * - `ready`       — the hotel exists; `hotelId` is safe to use
 * - `none`        — no workspace in this browser (or the stored one is gone)
 * - `unavailable` — a stored id exists but couldn't be checked (offline)
 */
export type WorkspaceStatus = "loading" | "ready" | "none" | "unavailable";

export interface WorkspaceState {
  /** Non-null only when `status` is "ready". */
  hotelId: string | null;
  status: WorkspaceStatus;
  /** Make a just-created hotel the active workspace. */
  enterWorkspace: (hotelId: string) => void;
  /** Re-check a stored workspace after an `unavailable` result. */
  retry: () => void;
}

export const WorkspaceContext = createContext<WorkspaceState>({
  hotelId: null,
  status: "loading",
  enterWorkspace: () => {},
  retry: () => {},
});

export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}
