/**
 * Toast notifications.
 *
 * One provider at the app root; every module calls useToast(). Toasts are
 * for confirming that something *worked* — a saved sale, a completed
 * transfer. Failures that block the user belong inline in the form that
 * caused them, not in a corner that disappears.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLE: Record<ToastTone, { icon: ReactNode; bar: string }> = {
  success: { icon: <CheckCircle2 size={18} />, bar: "var(--success)" },
  error: { icon: <AlertTriangle size={18} />, bar: "var(--danger)" },
  info: { icon: <Info size={18} />, bar: "var(--info)" },
};

const DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, tone, message }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed z-[9999] flex flex-col gap-2 bottom-4 right-4 left-4 sm:left-auto sm:w-[360px]"
        role="status"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className="flex items-start gap-3 rounded-xl bg-white px-4 py-3 text-sm shadow-lg"
              style={{ border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}
            >
              <span
                className="w-1 self-stretch rounded-full flex-none"
                style={{ background: TONE_STYLE[toast.tone].bar }}
              />
              <span className="pt-0.5 flex-none" style={{ color: TONE_STYLE[toast.tone].bar }}>
                {TONE_STYLE[toast.tone].icon}
              </span>
              <p className="flex-1 font-medium" style={{ color: "var(--text)" }}>
                {toast.message}
              </p>
              <button
                onClick={() => dismiss(toast.id)}
                className="icon-btn flex-none"
                style={{ width: 24, height: 24 }}
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
