/**
 * Reports view: period filters, Chart.js, PDF (jsPDF text) + CSV exports.
 */
import { loadUserSettings } from "./auth.js";
import { listCustomers } from "./customers.js";
import { listInvoicesForUser, formatInvoiceDate, round2 } from "./invoices.js";
import {
  getPeriodBounds,
  filterInvoicesForReport,
  computeReportAnalytics,
} from "./reports-analytics.js";
import { showToast } from "./toast.js";

function getChartCtor() {
  return typeof globalThis.Chart === "function" ? globalThis.Chart : null;
}

const PALETTE = ["#1a5f4a", "#2d8a6e", "#4a9d7e", "#0d6e4d", "#f59e0b", "#b42318"];

let chartInstances = [];
/** @type {Record<string, import("chart.js").Chart>} */
let chartsByKey = {};

let cacheInvoices = null;
let cacheCustomers = null;
let cacheSettings = null;
let filtersWired = false;

/** Snapshot for PDF / CSV (set after each successful generate). */
let lastExportState = null;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paymentMethodLabel(code) {
  const m = {
    credit_sale: "Credit sale",
    cash: "Cash",
    upi: "UPI",
    bank_transfer: "Bank transfer",
    cheque: "Cheque",
    card: "Card",
    other: "Other",
  };
  const k = String(code ?? "").trim();
  return m[k] || (k ? k.replace(/_/g, " ") : "—");
}

function fmtInr(n) {
  const x = Number(n) || 0;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(x);
  } catch (_) {
    return `₹${x.toFixed(2)}`;
  }
}

function localYmd(d) {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sumInvoiceDue(rows) {
  let t = 0;
  for (const inv of rows) {
    const total = round2(Number(inv.total) || 0);
    const paid = round2(Number(inv.amountPaidOnInvoice) || 0);
    t = round2(t + round2(total - paid));
  }
  return t;
}

function destroyReportCharts() {
  chartInstances.forEach((c) => {
    try {
      c.destroy();
    } catch (_) {}
  });
  chartInstances = [];
  chartsByKey = {};
}

function readFilterCriteria() {
  const presetEl = document.getElementById("report-preset");
  const fromEl = document.getElementById("report-from");
  const toEl = document.getElementById("report-to");
  const custEl = document.getElementById("report-customer");
  const payEl = document.getElementById("report-payment-status");
  const preset = (presetEl?.value || "today").trim();
  const custom =
    preset === "custom"
      ? { from: (fromEl?.value || "").trim(), to: (toEl?.value || "").trim() }
      : {};
  return {
    preset,
    custom,
    customerId: (custEl?.value || "").trim(),
    paymentStatus: (payEl?.value || "").trim(),
  };
}

function syncCustomRangeVisibility() {
  const presetEl = document.getElementById("report-preset");
  const wrap = document.getElementById("report-custom-dates");
  const isCustom = (presetEl?.value || "") === "custom";
  wrap?.classList.toggle("hidden", !isCustom);
}

function populateCustomerSelect(customers) {
  const sel = document.getElementById("report-customer");
  if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">All customers</option>']
    .concat(
      (customers || []).map(
        (c) =>
          `<option value="${escapeHtml(c.id)}">${escapeHtml((c.name || "").trim() || c.id)}</option>`
      )
    )
    .join("");
  sel.innerHTML = opts;
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function wireFiltersOnce() {
  if (filtersWired) return;
  const presetEl = document.getElementById("report-preset");
  const gen = document.getElementById("report-generate");
  const pdf = document.getElementById("report-download-pdf");
  const csv = document.getElementById("report-download-csv");

  presetEl?.addEventListener("change", () => {
    syncCustomRangeVisibility();
  });

  gen?.addEventListener("click", () => {
    runRefreshFromCache().catch((ex) => {
      console.error("[reports generate]", ex);
      showToast(ex?.message || "Could not refresh report.", { type: "error" });
    });
  });

  pdf?.addEventListener("click", () => {
    try {
      downloadReportPdf();
    } catch (ex) {
      console.error("[reports pdf]", ex);
      showToast(ex?.message || "Could not create PDF.", { type: "error" });
    }
  });

  csv?.addEventListener("click", () => {
    try {
      downloadReportCsv();
    } catch (ex) {
      console.error("[reports csv]", ex);
      showToast(ex?.message || "Could not download CSV.", { type: "error" });
    }
  });

  filtersWired = true;
  syncCustomRangeVisibility();
}

async function runRefreshFromCache() {
  if (cacheInvoices == null || cacheCustomers == null) {
    showToast("Reports are still loading.", { type: "info" });
    return;
  }
  await renderReportBody(cacheInvoices, cacheCustomers, cacheSettings || {});
}

/**
 * @param {Array<object>} invoices
 * @param {Array<object>} customers
 * @param {object} settings
 */
async function renderReportBody(invoices, customers, settings) {
  const root = document.getElementById("reports-root");
  if (!root) return;

  destroyReportCharts();

  const { preset, custom, customerId, paymentStatus } = readFilterCriteria();
  const { start, end, label: periodLabel } = getPeriodBounds(preset, custom);
  const range = { start, end };

  const filtered = filterInvoicesForReport(invoices, {
    start,
    end,
    customerId,
    paymentStatus,
  });

  let a;
  try {
    a = computeReportAnalytics(filtered, customers, range);
  } catch (aggEx) {
    console.error("[computeReportAnalytics]", aggEx);
    root.innerHTML = `<div class="card report-error"><p class="muted">Could not compute report totals. Try a different period.</p></div>`;
    showToast(aggEx?.message || "Report calculation failed.", { type: "error" });
    return;
  }

  const k = a.kpis;
  const dueOnInvoices = sumInvoiceDue(filtered);

  const business = (settings.sellerName || "").trim() || "Your business";
  const gstin = (settings.sellerGstin || "").trim();
  const genStr = new Date().toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const empty = filtered.length === 0;
  const bucketModeLabelEsc = escapeHtml(String(a.series?.bucketMode ?? ""));

  root.innerHTML = `
    <div class="report-card report-head card">
      <div class="report-head-main">
        <h2 class="report-head-title">${escapeHtml(business)}</h2>
        ${gstin ? `<p class="report-head-meta"><span class="report-head-k">GSTIN</span> ${escapeHtml(gstin)}</p>` : ""}
        <p class="report-head-period"><strong>${escapeHtml(periodLabel)}</strong> · ${escapeHtml(localYmd(start))} → ${escapeHtml(localYmd(end))}</p>
        <p class="report-head-generated muted small">Generated ${escapeHtml(genStr)}</p>
      </div>
    </div>

    <div class="report-kpi-strip">
      <div class="report-kpi">
        <span class="report-kpi-label">Invoices</span>
        <span class="report-kpi-value">${k.invoiceCount}</span>
      </div>
      <div class="report-kpi report-kpi--accent">
        <span class="report-kpi-label">Total billed</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(k.totalBilled))}</span>
      </div>
      <div class="report-kpi">
        <span class="report-kpi-label">Collected on invoice</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(k.totalCollected))}</span>
      </div>
      <div class="report-kpi report-kpi--warn">
        <span class="report-kpi-label">Due (filtered)</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(dueOnInvoices))}</span>
        <span class="report-kpi-sub">Unpaid balance on invoices in range</span>
      </div>
      <div class="report-kpi">
        <span class="report-kpi-label">Avg ticket</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(k.avgInvoice))}</span>
      </div>
      <div class="report-kpi">
        <span class="report-kpi-label">GST (CGST+SGST)</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(k.taxTotal))}</span>
      </div>
      <div class="report-kpi">
        <span class="report-kpi-label">Customer outstanding</span>
        <span class="report-kpi-value">${escapeHtml(fmtInr(k.outstanding))}</span>
        <span class="report-kpi-sub">All customers (ledger)</span>
      </div>
    </div>

    ${
      empty
        ? `<div class="card report-empty"><p class="muted">No invoices match these filters for the selected period.</p></div>`
        : `<div class="report-charts">
      <div class="report-charts-grid">
        <div class="report-chart-card report-chart-card--wide">
          <div class="report-chart-inner report-chart-inner--tall"><canvas id="report-canvas-trend"></canvas></div>
        </div>
        <div class="report-chart-card">
          <div class="report-chart-inner"><canvas id="report-canvas-pay-count"></canvas></div>
        </div>
        <div class="report-chart-card">
          <div class="report-chart-inner"><canvas id="report-canvas-tax"></canvas></div>
        </div>
        <div class="report-chart-card report-chart-card--wide">
          <div class="report-chart-inner report-chart-inner--tall"><canvas id="report-canvas-customers"></canvas></div>
        </div>
        <div class="report-chart-card report-chart-card--wide">
          <div class="report-chart-inner report-chart-inner--tall"><canvas id="report-canvas-methods"></canvas></div>
        </div>
      </div>
    </div>

    <div class="report-tables-grid">
      <div class="card report-table-card">
        <h3 class="h3-small">Recent invoices (period)</h3>
        <div class="table-wrap">
          <table class="report-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Customer</th>
                <th class="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${a.topInvoiceRows
                .slice(0, 15)
                .map(
                  (r) => `<tr>
                <td>${escapeHtml(r.invoiceNumber || r.id || "—")}</td>
                <td>${escapeHtml(formatInvoiceDate(r.date))}</td>
                <td>${escapeHtml((r.customerName || "").trim() || "—")}</td>
                <td class="num">${escapeHtml(fmtInr(r.total))}</td>
                <td>${escapeHtml(String(r.paymentStatus || "—"))}</td>
              </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card report-table-card">
        <h3 class="h3-small">Summary by bucket (${bucketModeLabelEsc})</h3>
        <div class="table-wrap">
          <table class="report-table">
            <thead>
              <tr>
                <th>Period</th>
                <th class="num">Billed (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${a.series.labels
                .map(
                  (lab, i) => `<tr>
                <td>${escapeHtml(lab)}</td>
                <td class="num">${escapeHtml(fmtInr(a.series.revenue[i] ?? 0))}</td>
              </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`
    }
  `;

  if (empty) {
    lastExportState = {
      settings,
      periodLabel,
      range,
      analytics: a,
      filteredRows: filtered,
      dueOnInvoices,
      empty: true,
    };
    return;
  }

  await new Promise((r) => requestAnimationFrame(r));

  const Chart = getChartCtor();
  if (!Chart) {
    const warn = document.createElement("p");
    warn.className = "muted small report-chart-missing";
    warn.textContent =
      "Charts could not load (Chart.js missing). Tables and KPIs above are still valid — refresh the page or check your network.";
    root.appendChild(warn);
    lastExportState = {
      settings,
      periodLabel,
      range,
      analytics: a,
      filteredRows: filtered,
      dueOnInvoices,
      empty: false,
      chartsByKey: {},
    };
    return;
  }

  const trendType = a.series.bucketMode === "day" ? "line" : "bar";
  const cTrend = document.getElementById("report-canvas-trend");
  const cPay = document.getElementById("report-canvas-pay-count");
  const cTax = document.getElementById("report-canvas-tax");
  const cCust = document.getElementById("report-canvas-customers");
  const cMeth = document.getElementById("report-canvas-methods");

  try {
  if (cTrend && Chart && a.series.labels.length > 0) {
    const ch =
      trendType === "line"
        ? new Chart(cTrend, {
            type: "line",
            data: {
              labels: a.series.labels,
              datasets: [
                {
                  label: "Billed (₹)",
                  data: a.series.revenue,
                  borderColor: PALETTE[1],
                  backgroundColor: "rgba(45, 138, 110, 0.12)",
                  fill: true,
                  tension: 0.25,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                title: { display: true, text: "Revenue trend", color: "#1c1f1e", font: { size: 13 } },
                legend: { display: false },
              },
              scales: { y: { beginAtZero: true } },
            },
          })
        : new Chart(cTrend, {
            type: "bar",
            data: {
              labels: a.series.labels,
              datasets: [
                {
                  label: "Billed (₹)",
                  data: a.series.revenue,
                  backgroundColor: PALETTE[0],
                  borderRadius: 4,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                title: { display: true, text: "Revenue trend", color: "#1c1f1e", font: { size: 13 } },
                legend: { display: false },
              },
              scales: { y: { beginAtZero: true } },
            },
          });
    chartInstances.push(ch);
    chartsByKey.trend = ch;
  }

  if (cPay && Chart) {
    const pc = a.paymentCount;
    const ch = new Chart(cPay, {
      type: "doughnut",
      data: {
        labels: ["Paid", "Unpaid", "Partial"],
        datasets: [
          {
            data: [pc.paid, pc.unpaid, pc.partial],
            backgroundColor: [PALETTE[0], PALETTE[5], PALETTE[4]],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: "Invoices by status", color: "#1c1f1e", font: { size: 13 } },
          legend: { position: "bottom" },
        },
      },
    });
    chartInstances.push(ch);
    chartsByKey.payCount = ch;
  }

  if (cTax && Chart) {
    const ch = new Chart(cTax, {
      type: "pie",
      data: {
        labels: ["CGST", "SGST"],
        datasets: [
          {
            data: [a.taxSplit.cgst, a.taxSplit.sgst],
            backgroundColor: [PALETTE[0], PALETTE[3]],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: "GST split", color: "#1c1f1e", font: { size: 13 } },
          legend: { position: "bottom" },
        },
      },
    });
    chartInstances.push(ch);
    chartsByKey.tax = ch;
  }

  if (cCust && Chart && a.topCustomers.length > 0) {
    const top = a.topCustomers.slice(0, 10);
    const ch = new Chart(cCust, {
      type: "bar",
      data: {
        labels: top.map((r) => {
          const nm = String(r.name ?? "").trim() || "—";
          return nm.length > 32 ? `${nm.slice(0, 30)}…` : nm;
        }),
        datasets: [
          {
            label: "Billed (₹)",
            data: top.map((r) => r.total),
            backgroundColor: PALETTE[2],
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: "Top customers", color: "#1c1f1e", font: { size: 13 } },
          legend: { display: false },
        },
        scales: { x: { beginAtZero: true } },
      },
    });
    chartInstances.push(ch);
    chartsByKey.customers = ch;
  }

  if (cMeth && Chart && a.paymentMethods.length > 0) {
    const pm = a.paymentMethods;
    const ch = new Chart(cMeth, {
      type: "bar",
      data: {
        labels: pm.map(([k]) => paymentMethodLabel(k)),
        datasets: [
          {
            label: "Invoices",
            data: pm.map(([, v]) => v),
            backgroundColor: PALETTE[1],
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: "Payment methods", color: "#1c1f1e", font: { size: 13 } },
          legend: { display: false },
        },
        scales: { y: { beginAtZero: true } },
      },
    });
    chartInstances.push(ch);
    chartsByKey.methods = ch;
  }
  } catch (chartEx) {
    console.error("[reports charts]", chartEx);
    showToast("Some charts could not be drawn. Tables and KPIs are still shown.", { type: "info" });
  }

  await new Promise((r) => requestAnimationFrame(r));

  lastExportState = {
    settings,
    periodLabel,
    range,
    analytics: a,
    filteredRows: filtered,
    dueOnInvoices,
    empty: false,
    chartsByKey,
  };
}

function fmtPdfInr(n) {
  const x = Number(n) || 0;
  return `INR ${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Standard PDF fonts only support WinAnsi; Unicode arrows/dots break spacing in viewers.
 */
function pdfAscii(s) {
  return String(s ?? "")
    .replace(/\u2192/g, " to ")
    .replace(/\u00b7/g, " | ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ");
}

function truncatePdfCell(s, maxChars) {
  const t = pdfAscii(String(s ?? "").trim());
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** jsPDF UMD sets `window.jspdf.jsPDF` (vendored in js/vendor). */
function getJsPDFConstructor() {
  const w = typeof globalThis !== "undefined" ? globalThis : window;
  const pkg = w.jspdf;
  if (pkg && typeof pkg.jsPDF === "function") return pkg.jsPDF;
  if (typeof w.jsPDF === "function") return w.jsPDF;
  return null;
}

/**
 * Report PDF: jsPDF vector text, ASCII-safe strings, sectioned layout, table columns, footers.
 */
function downloadReportPdf() {
  if (!lastExportState) {
    showToast("Generate a report first.", { type: "info" });
    return;
  }
  const JsPDF = getJsPDFConstructor();
  if (!JsPDF) {
    showToast("PDF library not loaded. Hard-refresh the page (Ctrl+Shift+R) or check that js/vendor/jspdf.umd.min.js is deployed.", {
      type: "error",
    });
    return;
  }

  const state = lastExportState;
  const k = state.analytics?.kpis;
  const a = state.analytics;
  if (!k || !a) {
    showToast("Generate a report first.", { type: "info" });
    return;
  }

  try {
    const doc = new JsPDF({ unit: "mm", format: "a4", compress: true });
    const margin = 14;
    const footerH = 8;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const innerRight = pageW - margin;
    const maxW = pageW - margin * 2;
    const contentBottom = pageH - margin - footerH;
    let y = margin;

    const business = pdfAscii((state.settings.sellerName || "").trim() || "Your business");
    const gstin = pdfAscii((state.settings.sellerGstin || "").trim());
    const genStr = pdfAscii(
      new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    );
    const r0 = state.range.start;
    const r1 = state.range.end;
    const periodTitle = pdfAscii(state.periodLabel);
    const dateRangeLine = `${localYmd(r0)} to ${localYmd(r1)}`;

    const colInv = margin;
    const colDate = 44;
    const colCust = 66;
    /** Amount is right-aligned to this x; status column starts after. */
    const colAmtRight = 150;
    const colStat = 154;

    const drawHLine = (y1) => {
      doc.setDrawColor(210, 216, 213);
      doc.setLineWidth(0.35);
      doc.line(margin, y1, innerRight, y1);
    };

    const ensureRoom = (needMm) => {
      if (y + needMm <= contentBottom) return;
      doc.addPage();
      y = margin;
    };

    const writeTitle = (text, size, style) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(15, 47, 42);
      for (const ln of doc.splitTextToSize(text, maxW)) {
        ensureRoom(6);
        doc.text(ln, margin, y);
        y += size * 0.45;
      }
      doc.setTextColor(0, 0, 0);
    };

    const writeBody = (text, size, color) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(size);
      if (color) doc.setTextColor(color[0], color[1], color[2]);
      for (const ln of doc.splitTextToSize(text, maxW)) {
        ensureRoom(5);
        doc.text(ln, margin, y);
        y += size * 0.42;
      }
      doc.setTextColor(0, 0, 0);
    };

    const sectionRule = () => {
      y += 2;
      drawHLine(y);
      y += 4;
    };

    const drawKv = (label, value) => {
      ensureRoom(5);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(label, margin, y);
      doc.text(String(value), innerRight, y, { align: "right" });
      y += 4.5;
    };

    /* --- Cover / header --- */
    writeTitle(business, 16, "bold");
    y += 2;
    drawHLine(y);
    y += 5;

    if (gstin) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      ensureRoom(5);
      doc.text(`GSTIN: ${gstin}`, margin, y);
      y += 5;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    ensureRoom(5);
    doc.text("Reporting period", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    ensureRoom(5);
    doc.text(periodTitle, margin, y);
    y += 4;
    ensureRoom(5);
    doc.text(dateRangeLine, margin, y);
    y += 5;

    doc.setTextColor(75, 82, 78);
    doc.setFontSize(8.5);
    ensureRoom(4);
    doc.text(`Generated: ${genStr}`, margin, y);
    doc.setTextColor(0, 0, 0);
    y += 6;

    sectionRule();

    /* --- Summary (aligned label / value) --- */
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 95, 74);
    ensureRoom(6);
    doc.text("Summary", margin, y);
    doc.setTextColor(0, 0, 0);
    y += 6;

    drawKv("Invoices in period", k.invoiceCount);
    drawKv("Total billed", fmtPdfInr(k.totalBilled));
    drawKv("Collected on invoice", fmtPdfInr(k.totalCollected));
    drawKv("Due (filtered invoices)", fmtPdfInr(state.dueOnInvoices));
    drawKv("Average ticket", fmtPdfInr(k.avgInvoice));
    drawKv("GST (total)", fmtPdfInr(k.taxTotal));
    drawKv("Customer outstanding (ledger)", fmtPdfInr(k.outstanding));
    drawKv("Rows in CSV export (same filters)", state.filteredRows?.length ?? 0);

    y += 4;
    sectionRule();

    /* --- Invoice table --- */
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 95, 74);
    ensureRoom(6);
    doc.text(state.empty ? "Invoices" : "Recent invoices (sample)", margin, y);
    doc.setTextColor(0, 0, 0);
    y += 7;

    const drawInvoiceHeader = () => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(55, 65, 62);
      doc.text("Invoice", colInv, y);
      doc.text("Date", colDate, y);
      doc.text("Customer", colCust, y);
      doc.text("Amount (INR)", colAmtRight, y, { align: "right" });
      doc.text("Status", colStat, y);
      doc.setTextColor(0, 0, 0);
      y += 3;
      doc.setDrawColor(200, 206, 203);
      doc.setLineWidth(0.25);
      doc.line(margin, y, innerRight, y);
      y += 4;
      doc.setFont("helvetica", "normal");
    };

    if (state.empty) {
      writeBody("No invoices match these filters for the selected period.", 9, [90, 95, 93]);
    } else {
      ensureRoom(14);
      drawInvoiceHeader();
      for (const r of a.topInvoiceRows.slice(0, 20)) {
        if (y + 6 > contentBottom) {
          doc.addPage();
          y = margin;
          drawInvoiceHeader();
        }
        const inv = truncatePdfCell(r.invoiceNumber || r.id || "—", 14);
        const dt = truncatePdfCell(formatInvoiceDate(r.date), 12);
        const cust = truncatePdfCell((r.customerName || "").trim() || "—", 34);
        const amt = fmtPdfInr(Number(r.total) || 0);
        const st = truncatePdfCell(String(r.paymentStatus || "—"), 12);

        doc.setFontSize(8);
        doc.text(inv, colInv, y);
        doc.text(dt, colDate, y);
        doc.text(cust, colCust, y);
        doc.text(amt, colAmtRight, y, { align: "right" });
        doc.text(st, colStat, y);
        y += 5;
      }
    }

    /* --- Footers on every page --- */
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(120, 128, 124);
      doc.text(
        `Easy Billing - Sales report  |  Page ${p} of ${totalPages}`,
        pageW / 2,
        pageH - 5,
        { align: "center" }
      );
      doc.setTextColor(0, 0, 0);
    }

    const fn = `report-${localYmd(state.range.start)}--${localYmd(state.range.end)}.pdf`;
    doc.save(fn);
    showToast("PDF downloaded.", { type: "success" });
  } catch (pdfEx) {
    console.error("[downloadReportPdf]", pdfEx);
    showToast(pdfEx?.message || "PDF export failed.", { type: "error" });
  }
}

function downloadReportCsv() {
  if (!lastExportState || !lastExportState.filteredRows?.length) {
    showToast("No rows to export. Adjust filters or generate again.", { type: "info" });
    return;
  }
  const rows = lastExportState.filteredRows;
  const headers = [
    "Invoice number",
    "Date",
    "Customer",
    "Total (INR)",
    "Paid (INR)",
    "Due (INR)",
    "Status",
    "Payment method",
    "CGST",
    "SGST",
  ];
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    const total = round2(Number(r.total) || 0);
    const paid = round2(Number(r.amountPaidOnInvoice) || 0);
    const due = round2(total - paid);
    const line = [
      r.invoiceNumber || r.id || "",
      formatInvoiceDate(r.date),
      (r.customerName || "").trim(),
      String(total),
      String(paid),
      String(due),
      String(r.paymentStatus || ""),
      paymentMethodLabel(r.paymentMethod),
      String(round2(Number(r.cgst) || 0)),
      String(round2(Number(r.sgst) || 0)),
    ].map(csvEscape);
    lines.push(line.join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const fn = `report-${localYmd(lastExportState.range.start)}--${localYmd(lastExportState.range.end)}.csv`;
  a.href = URL.createObjectURL(blob);
  a.download = fn;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("CSV downloaded.", { type: "success" });
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 */
export async function mountReports(db, uid) {
  const root = document.getElementById("reports-root");
  if (!root) return;

  destroyReportCharts();
  root.innerHTML = `<p class="muted report-loading-msg">Loading invoice data…</p>`;

  let invoices;
  let customers;
  let settings;
  try {
    [invoices, customers, settings] = await Promise.all([
      listInvoicesForUser(db, uid),
      listCustomers(db, uid),
      loadUserSettings(uid),
    ]);
  } catch (ex) {
    const msg =
      ex && ex.code === "permission-denied"
        ? "Could not load data. Check Firestore rules."
        : ex?.message
          ? String(ex.message)
          : "Could not load reports.";
    root.innerHTML = `<div class="card report-error"><p class="muted">${escapeHtml(msg)}</p></div>`;
    console.error("[mountReports]", ex);
    return;
  }

  cacheInvoices = invoices;
  cacheCustomers = customers;
  cacheSettings = settings;

  populateCustomerSelect(customers);
  wireFiltersOnce();

  const today = new Date();
  const fromEl = document.getElementById("report-from");
  const toEl = document.getElementById("report-to");
  if (fromEl && !fromEl.value) fromEl.value = localYmd(today);
  if (toEl && !toEl.value) toEl.value = localYmd(today);

  try {
    await renderReportBody(invoices, customers, settings);
  } catch (ex) {
    console.error("[mountReports] renderReportBody", ex);
    root.innerHTML = `<div class="card report-error"><p class="muted">${escapeHtml(
      ex?.message || "Could not build this report."
    )}</p><p class="small muted">Try another date range or refresh the page.</p></div>`;
    showToast("Could not render report.", { type: "error" });
  }
}

export function teardownReports() {
  destroyReportCharts();
  lastExportState = null;
  const root = document.getElementById("reports-root");
  if (root) root.innerHTML = "";
  const exp = document.getElementById("report-export-root");
  if (exp) {
    exp.innerHTML = "";
    exp.classList.remove("report-export-root--active");
  }
}
