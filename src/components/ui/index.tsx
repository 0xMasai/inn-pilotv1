/**
 * The shared presentation kit.
 *
 * Every module composes its pages from these, so spacing, radii, empty
 * states and loading behaviour are identical across Dashboard, Bar,
 * Parking and the rest without a single page re-inventing them.
 */
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { money, percent } from "../../lib/format";

export { Modal, ConfirmDialog } from "./Modal";
// useToast is a hook, not a component, so re-exporting it here trips the
// fast-refresh lint rule. Keeping it on the barrel is worth the exemption:
// every module imports its UI from one path.
// eslint-disable-next-line react-refresh/only-export-components
export { ToastProvider, useToast } from "./Toast";

// ---------- Page scaffolding ----------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="min-w-0">
        <h2 className="page-title">{title}</h2>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header
          className="flex items-center justify-between gap-3 px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {title && <h3 className="section-title">{title}</h3>}
          {action}
        </header>
      )}
      <div className={bodyClassName || "p-5"}>{children}</div>
    </section>
  );
}

// ---------- KPI ----------

export type StatTone = "primary" | "success" | "warning" | "danger" | "purple" | "orange";

const TONE_CLASS: Record<StatTone, string> = {
  primary: "",
  success: "is-success",
  warning: "is-warning",
  danger: "is-danger",
  purple: "is-purple",
  orange: "is-orange",
};

export interface StatCardProps {
  label: string;
  /** Pre-formatted. Use money()/percent() from lib/format at the call site. */
  value: string;
  icon: ReactNode;
  tone?: StatTone;
  hint?: string;
  /** Percentage change vs the previous period; omit when there's nothing to compare. */
  delta?: number | null;
  /** For expenses, a rise is bad — flips the delta's colour, not its arrow. */
  invertDelta?: boolean;
  loading?: boolean;
  index?: number;
}

export function StatCard({
  label,
  value,
  icon,
  tone = "primary",
  hint,
  delta,
  invertDelta = false,
  loading = false,
  index = 0,
}: StatCardProps) {
  if (loading) {
    return (
      <div className="stat-card">
        <div className="stat-top">
          <div className="skeleton" style={{ height: 12, width: 90 }} />
          <div className="skeleton" style={{ height: 38, width: 38, borderRadius: 8 }} />
        </div>
        <div className="skeleton" style={{ height: 28, width: 140 }} />
        <div className="skeleton" style={{ height: 11, width: 110 }} />
      </div>
    );
  }

  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const rising = hasDelta && delta > 0;
  const good = invertDelta ? !rising : rising;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index, 8) * 0.04 }}
      className="stat-card"
    >
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${TONE_CLASS[tone]}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="flex items-center gap-2 flex-wrap">
        {hasDelta && delta !== 0 && (
          <span
            className="inline-flex items-center gap-1 text-xs font-semibold"
            style={{ color: good ? "var(--success-text)" : "var(--danger-text)" }}
          >
            {rising ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(Math.round(delta))}%
          </span>
        )}
        {hint && <span className="text-xs muted">{hint}</span>}
      </div>
    </motion.div>
  );
}

/** Grid wrapper that keeps KPI rows on the same rhythm everywhere. */
export function StatGrid({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <div
      className={`grid gap-4 grid-cols-1 sm:grid-cols-2 ${
        columns === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"
      }`}
    >
      {children}
    </div>
  );
}

// ---------- Empty & loading ----------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p className="empty-title">{title}</p>
      <p className="empty-desc">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Skeleton rows sized to a table, so loading doesn't collapse the layout. */
export function TableSkeleton({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}>
              <div className="skeleton" style={{ height: 13, width: c === 0 ? 120 : 72 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------- Small pieces ----------

/** Segmented control — the date-range switcher and every tab strip. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (key: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.key}
          role="tab"
          aria-selected={value === opt.key}
          onClick={() => onChange(opt.key)}
          className={`segmented-item ${value === opt.key ? "is-active" : ""}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A labelled progress bar — the department revenue breakdown. Preferred
 * over a pie chart: shares are read against a common baseline, and it
 * stays legible on a phone.
 */
export function ShareBar({
  name,
  amount,
  share,
  color,
  currency,
}: {
  name: string;
  amount: number;
  share: number;
  color: string;
  currency?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
          {name}
        </span>
        <span className="text-sm tabular-nums" style={{ color: "var(--text-secondary)" }}>
          {money(amount, currency)}
          <span className="muted ml-2 text-xs">{percent(share, "0%")}</span>
        </span>
      </div>
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ background: "var(--surface-muted)" }}
        role="img"
        aria-label={`${name}: ${percent(share, "0%")} of revenue`}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

/** Inline form error. Blocking problems are shown where they happened. */
export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      className="text-sm rounded-lg px-3 py-2.5"
      style={{
        background: "var(--danger-soft)",
        color: "var(--danger-text)",
        border: "1px solid var(--danger-border)",
      }}
      role="alert"
    >
      {message}
    </div>
  );
}

export function Field({
  label,
  required = false,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs muted mt-1">{hint}</p>}
    </div>
  );
}
