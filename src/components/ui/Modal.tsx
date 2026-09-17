/**
 * Modal dialog and its destructive-action sibling.
 *
 * ConfirmDialog is deliberately the only confirmation primitive in the
 * app, and it is reserved for actions that lose data or cannot be undone.
 * Ordinary saves just save and toast — asking "are you sure?" on every
 * click is what makes software feel bureaucratic.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";

type ModalWidth = "sm" | "md" | "lg" | "xl";

const WIDTH: Record<ModalWidth, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  width?: ModalWidth;
  children: ReactNode;
  /** Sticky action row pinned to the bottom of the panel. */
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  width = "md",
  children,
  footer,
}: ModalProps) {
  // Escape closes, and the page behind must not scroll while a dialog is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.div
            className={`modal-panel ${WIDTH[width]}`}
            initial={{ y: 20, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 12, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="modal-header">
              <div className="min-w-0">
                <h2 className="modal-title truncate">{title}</h2>
                {description && (
                  <p className="text-sm muted mt-0.5">{description}</p>
                )}
              </div>
              <button className="icon-btn flex-none" onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5">{children}</div>

            {footer && (
              <div
                className="flex items-center justify-end gap-2 px-6 py-4 sticky bottom-0 bg-white"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      width="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-4">
        <span
          className="flex-none w-10 h-10 rounded-full flex items-center justify-center"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <AlertTriangle size={20} />
        </span>
        <p className="text-sm pt-2" style={{ color: "var(--text-secondary)" }}>
          {message}
        </p>
      </div>
    </Modal>
  );
}
