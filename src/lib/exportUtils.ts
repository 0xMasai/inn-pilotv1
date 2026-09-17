/**
 * Centralized export utilities for PDF and CSV downloads across InnPilot.
 *
 * Ensures all reports, transaction tables, and administrative records can
 * be downloaded as professional PDF documents or Excel-friendly CSV files.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export interface ExportKpi {
  label: string;
  value: string;
}

export interface ExportOptions {
  title: string;
  subtitle?: string;
  filename: string;
  columns: string[];
  rows: (string | number | boolean | null | undefined)[][];
  kpis?: ExportKpi[];
}

/** Sanitize file names for safe desktop and browser saving */
function sanitizeFilename(name: string, ext: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean || "report"}.${ext}`;
}

/**
 * Exports data to CSV and triggers direct browser download.
 * Adds UTF-8 BOM so Excel opens special characters (e.g. UGX, $, €) accurately.
 */
export function exportToCsv({
  title,
  subtitle,
  filename,
  columns,
  rows,
  kpis,
}: ExportOptions): void {
  const escapeCell = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines: string[] = [];

  // Title header
  lines.push(escapeCell(title));
  if (subtitle) {
    lines.push(escapeCell(`Period / Scope: ${subtitle}`));
  }
  lines.push(escapeCell(`Generated on: ${new Date().toLocaleString()}`));
  lines.push("");

  // Key metrics summary if provided
  if (kpis && kpis.length > 0) {
    lines.push("Summary Metrics");
    for (const k of kpis) {
      lines.push(`${escapeCell(k.label)},${escapeCell(k.value)}`);
    }
    lines.push("");
  }

  // Table header
  lines.push(columns.map(escapeCell).join(","));

  // Table rows
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }

  // Prepend UTF-8 BOM (\uFEFF)
  const csvContent = "\uFEFF" + lines.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeFilename(filename, "csv");
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exports data to a formatted, publication-ready PDF document and triggers download.
 */
export function exportToPdf({
  title,
  subtitle,
  filename,
  columns,
  rows,
  kpis,
}: ExportOptions): void {
  // Use landscape if more than 5 columns
  const orientation = columns.length > 5 ? "landscape" : "portrait";
  const doc = new jsPDF({
    orientation,
    unit: "mm",
    format: "a4",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  // Header Brand & Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42); // slate-900
  doc.text(title, margin, 18);

  // Subtitle & Timestamp
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // slate-500
  const metaText = `${subtitle ? `Period: ${subtitle}  ·  ` : ""}Generated on ${new Date().toLocaleString()}  ·  InnPilot Hotel OS`;
  doc.text(metaText, margin, 24);

  // Divider line
  doc.setDrawColor(226, 232, 240); // slate-200
  doc.setLineWidth(0.4);
  doc.line(margin, 27, pageWidth - margin, 27);

  let currentY = 33;

  // Render KPI cards block if present
  if (kpis && kpis.length > 0) {
    const cardWidth = Math.min(48, (pageWidth - margin * 2 - (kpis.length - 1) * 4) / kpis.length);
    let cardX = margin;

    kpis.forEach((kpi) => {
      // Card background
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.roundedRect(cardX, currentY, cardWidth, 14, 2, 2, "FD");

      // Label
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(kpi.label, cardX + 3, currentY + 4.5);

      // Value
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 41, 59);
      doc.text(kpi.value, cardX + 3, currentY + 11);

      cardX += cardWidth + 4;
    });

    currentY += 19;
  }

  // Table rendered via autotable
  autoTable(doc, {
    startY: currentY,
    head: [columns],
    body: rows.map((r) => r.map((c) => (c === null || c === undefined ? "-" : String(c)))),
    margin: { left: margin, right: margin },
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: [30, 58, 138], // brand blue #1e3a8a
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 8.5,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    didDrawPage: () => {
      // Footer page numbering
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      const str = `Page ${doc.getNumberOfPages()}`;
      doc.text(str, pageWidth - margin - 12, doc.internal.pageSize.getHeight() - 8);
    },
  });

  doc.save(sanitizeFilename(filename, "pdf"));
}
