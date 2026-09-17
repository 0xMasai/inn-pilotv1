/**
 * Display formatting.
 *
 * Money is rendered in exactly one place so a currency change is a
 * one-line edit rather than a hunt through every module. The hotel's
 * currency is a Settings field (hotels/{id}.currency); until a hotel sets
 * one, DEFAULT_CURRENCY applies.
 */
export const DEFAULT_CURRENCY = "UGX";

/** "UGX 1,250,000" — no decimals: these are whole-shilling amounts. */
export function money(value: unknown, currency = DEFAULT_CURRENCY): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return `${currency} 0`;
  const sign = amount < 0 ? "−" : "";
  return `${sign}${currency} ${Math.round(Math.abs(amount)).toLocaleString()}`;
}

/** "1,250,000" — for chart axes and table cells that already show a unit. */
export function num(value: unknown): string {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount).toLocaleString() : "0";
}

/** Compact money for tight KPI cards: "UGX 1.3M". */
export function moneyCompact(value: unknown, currency = DEFAULT_CURRENCY): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return `${currency} 0`;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${sign}${currency} ${(abs / 1_000).toFixed(0)}K`;
  return money(amount, currency);
}

export function percent(value: number | null, fallback = "—"): string {
  return value === null ? fallback : `${Math.round(value)}%`;
}

export function dateTime(d: Date | null | undefined): string {
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function dateShort(d: Date | null | undefined): string {
  return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export function timeShort(d: Date | null | undefined): string {
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

/** "3 items" / "1 item" — avoids a pluralisation ternary at every call site. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
