/**
 * Resolves the active workspace once, at startup.
 *
 * A stored hotelId is never trusted on sight: it is checked against
 * Firestore before any module reads with it. A hotel that no longer
 * exists (or an id someone typed into devtools) is forgotten and the
 * visitor lands on the marketing page, rather than every screen rendering
 * empty against a hotel that isn't there.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getDoc } from "firebase/firestore";
import { hotelDocRef } from "../lib/hotelScope";
import { errorCode } from "../lib/serviceResult";
import {
  WORKSPACE_STORAGE_KEY,
  WorkspaceContext,
  type WorkspaceStatus,
} from "./workspaceContext";

/** Firestore document ids: anything else is not worth a network call. */
const HOTEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * localStorage can throw (private mode, blocked site data), so every
 * access is guarded and a failure behaves like "no workspace stored".
 */
function readStoredHotelId(): string | null {
  try {
    const value = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return value && HOTEL_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeHotelId(hotelId: string | null): void {
  try {
    if (hotelId) localStorage.setItem(WORKSPACE_STORAGE_KEY, hotelId);
    else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // Nothing to do: the workspace still works for this session.
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [candidate, setCandidate] = useState<string | null>(readStoredHotelId);
  const [status, setStatus] = useState<WorkspaceStatus>(candidate ? "loading" : "none");
  const [attempt, setAttempt] = useState(0);
  /** A hotel this session just created needs no second round-trip to verify. */
  const verified = useRef<string | null>(null);

  useEffect(() => {
    if (!candidate) {
      setStatus("none");
      return;
    }
    if (verified.current === candidate) {
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");

    getDoc(hotelDocRef(candidate))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          verified.current = candidate;
          setStatus("ready");
        } else {
          storeHotelId(null);
          setCandidate(null);
          setStatus("none");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Could not open the stored workspace:", err);
        // A denied read means the id itself is not a valid workspace; any
        // other failure is most likely connectivity, which a retry fixes.
        if (errorCode(err) === "permission-denied") {
          storeHotelId(null);
          setCandidate(null);
          setStatus("none");
        } else {
          setStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [candidate, attempt]);

  const enterWorkspace = useCallback((hotelId: string) => {
    storeHotelId(hotelId);
    verified.current = hotelId;
    setCandidate(hotelId);
    setStatus("ready");
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <WorkspaceContext.Provider
      value={{
        hotelId: status === "ready" ? candidate : null,
        status,
        enterWorkspace,
        retry,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
