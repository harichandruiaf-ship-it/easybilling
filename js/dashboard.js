/**
 * Business dashboard: KPIs + Chart.js visualizations. Cards open a detail modal on click.
 */
import { listInvoicesForUser, round2 } from "./invoices.js";
import { listCustomers } from "./customers.js";
import { listOpenQuickOrders, getQuickOrderById, markQuickOrderDone } from "./quick-orders.js";
import { showToast } from "./toast.js";
import { computeAnalytics } from "./dashboard-analytics.js";

const Chart = globalThis.Chart;

let chartInstances = [];
let modalChart = null;
let lastAnalytics = null;

/** Latest mount context for quick-order modal / dismiss actions */
let lastDashboardMount = { db: null, uid: null };

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
  };
  const k = String(code || "").trim();
  return m[k] || (k ? k.replace(/_/g, " ") : "—");
}

function destroyCharts() {
  chartInstances.forEach((c) => {
    try {
      c.destroy();
    } catch (_) {}
  });
  chartInstances = [];
}

/** Shared Chart.js defaults (avoid rebuilding options per chart). */
const CHART_BASE = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: { color: "#1c1f1e", font: { family: "system-ui, sans-serif", size: 11 } },
    },
  },
};

function chartWithTitle(title) {
  return {
    ...CHART_BASE,
    plugins: {
      ...CHART_BASE.plugins,
      title: { display: true, text: title, color: "#1c1f1e", font: { size: 13 } },
    },
  };
}

function chartWithTitleScales(title, scales, extra = {}) {
  return {
    ...CHART_BASE,
    ...extra,
    scales,
    plugins: {
      ...CHART_BASE.plugins,
      title: { display: true, text: title, color: "#1c1f1e", font: { size: 13 } },
    },
  };
}

function buildKpiCard(label, value, sub, accent) {
  return `
    <div class="dashboard-kpi ${accent ? `dashboard-kpi--${accent}` : ""}">
      <span class="dashboard-kpi-label">${escapeHtml(label)}</span>
      <span class="dashboard-kpi-value">${escapeHtml(value)}</span>
      ${sub ? `<span class="dashboard-kpi-sub">${escapeHtml(sub)}</span>` : ""}
    </div>`;
}

function formatQuickOrderDate(iso) {
  const s = String(iso || "").trim();
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function closeDashboardQuickOrderModal() {
  const modal = document.getElementById("dashboard-qo-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    modal.dataset.currentQoId = "";
  }
}

/**
 * @param {Record<string, unknown>} order
 */
function buildQuickOrderDetailHtml(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const rows = lines
    .filter((l) => (l.productName || "").trim())
    .map(
      (l) =>
        `<tr><td>${escapeHtml((l.productName || "").trim())}</td><td class="num">${escapeHtml(String(l.quantity ?? ""))}</td><td>${escapeHtml((l.unit || "Pcs").trim())}</td></tr>`
    )
    .join("");
  const phone = (order.customerPhone || "").trim();
  const memo = (order.memo || "").trim();
  return `
    <dl class="dashboard-qo-dl">
      <div><dt>Send / deliver by</dt><dd>${escapeHtml(formatQuickOrderDate(order.sendDate))}</dd></div>
      <div><dt>Phone</dt><dd>${phone ? escapeHtml(phone) : "—"}</dd></div>
    </dl>
    <p class="small muted" style="margin:0 0 0.5rem">Products</p>
    <div class="table-wrap">
      <table class="dashboard-qo-table">
        <thead><tr><th>Product</th><th class="num">Qty</th><th>Unit</th></tr></thead>
        <tbody>${rows.length ? rows : `<tr><td colspan="3" class="muted">—</td></tr>`}</tbody>
      </table>
    </div>
    ${memo ? `<p class="dashboard-qo-memo"><strong>Notes</strong><br/>${escapeHtml(memo)}</p>` : ""}`;
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 * @param {string} orderId
 */
async function openDashboardQuickOrderModal(db, uid, orderId) {
  let order;
  try {
    order = await getQuickOrderById(db, orderId);
  } catch (ex) {
    showToast(ex?.message || "Could not load quick order.", { type: "error" });
    return;
  }
  if (!order || order.userId !== uid || (order.status || "open") !== "open") {
    showToast("Quick order not found or already completed.", { type: "error" });
    return;
  }
  const modal = document.getElementById("dashboard-qo-modal");
  const body = document.getElementById("dashboard-qo-modal-body");
  const title = document.getElementById("dashboard-qo-modal-title");
  const createA = document.getElementById("dashboard-qo-modal-create");
  if (!modal || !body) return;
  if (title) title.textContent = order.customerName || "Quick order";
  body.innerHTML = buildQuickOrderDetailHtml(order);
  modal.dataset.currentQoId = orderId;
  if (createA) {
    createA.href = `#/create?quickOrder=${encodeURIComponent(orderId)}`;
  }
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function ensureDashboardQuickOrderModalWired() {
  if (document.body.dataset.dashboardQoModalWired) return;
  document.body.dataset.dashboardQoModalWired = "1";
  document.getElementById("dashboard-qo-modal-close")?.addEventListener("click", closeDashboardQuickOrderModal);
  document.getElementById("dashboard-qo-modal-backdrop")?.addEventListener("click", closeDashboardQuickOrderModal);
  document.getElementById("dashboard-qo-modal-mark-done")?.addEventListener("click", async () => {
    const modal = document.getElementById("dashboard-qo-modal");
    const id = modal?.dataset?.currentQoId;
    const { db, uid } = lastDashboardMount;
    if (!id || !db || !uid) return;
    try {
      await markQuickOrderDone(db, id, uid);
      showToast("Marked as done.");
      closeDashboardQuickOrderModal();
      await mountDashboard(db, uid);
    } catch (ex) {
      showToast(ex?.message || "Could not update.", { type: "error" });
    }
  });
}

/**
 * @param {Array<{ id: string, customerName?: string, sendDate?: string, lines?: Array<{ productName?: string, quantity?: number }> }>} openOrders
 */
function buildQuickOrdersDashboardStrip(openOrders) {
  if (!openOrders.length) return "";
  const top = openOrders.slice(0, 6);
  const items = top
    .map((row) => {
      const lines = Array.isArray(row.lines) ? row.lines : [];
      const summary = lines
        .filter((l) => (l.productName || "").trim())
        .slice(0, 2)
        .map((l) => `${escapeHtml((l.productName || "").trim())} × ${escapeHtml(String(l.quantity ?? ""))}`)
        .join(" · ");
      const more = lines.filter((l) => (l.productName || "").trim()).length > 2 ? "…" : "";
      const cust = row.customerName || "Customer";
      return `<li class="dashboard-qo-item-card" data-qo-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="View quick order: ${escapeHtml(cust)}">
        <button type="button" class="dashboard-qo-dismiss" data-id="${escapeHtml(row.id)}" aria-label="Mark as done">✕</button>
        <div class="dashboard-qo-item-inner">
          <div class="dashboard-qo-item-main">
            <span class="dashboard-qo-name">${escapeHtml(cust)}</span>
            <span class="dashboard-qo-due">Due ${escapeHtml(formatQuickOrderDate(row.sendDate))}</span>
          </div>
          <p class="dashboard-qo-lines muted small">${summary || "—"}${more}</p>
        </div>
        <a class="btn btn-primary btn-small dashboard-qo-create-link" href="#/create?quickOrder=${encodeURIComponent(row.id)}">Create invoice</a>
      </li>`;
    })
    .join("");
  return `
    <section class="dashboard-quick-orders card" aria-labelledby="dash-qo-heading">
      <div class="dashboard-quick-orders-head">
        <h2 id="dash-qo-heading" class="dashboard-quick-orders-title">Quick orders — bill when ready</h2>
        <a href="#/quick-orders" class="btn btn-secondary btn-small">Manage all</a>
      </div>
      <ul class="dashboard-quick-orders-list">${items}</ul>
    </section>`;
}

function renderChartsInRoot(root, a) {
  if (!Chart) {
    root.querySelector("#dashboard-charts-slot").innerHTML =
      '<p class="muted">Chart library failed to load. Refresh the page.</p>';
    return;
  }

  const palette = ["#1a5f4a", "#2d8a6e", "#4a9d7e", "#0d6e4d", "#f59e0b", "#b42318", "#64748b"];

  const pc = a.paymentCount;
  const doughnutCount = new Chart(document.getElementById("chart-payment-count"), {
    type: "doughnut",
    data: {
      labels: ["Paid", "Unpaid", "Partial"],
      datasets: [
        {
          data: [pc.paid, pc.unpaid, pc.partial],
          backgroundColor: [palette[0], palette[5], palette[4]],
          borderWidth: 0,
        },
      ],
    },
    options: chartWithTitle("Invoice count by status"),
  });
  chartInstances.push(doughnutCount);

  const pa = a.paymentAmount;
  const doughnutAmt = new Chart(document.getElementById("chart-payment-amount"), {
    type: "doughnut",
    data: {
      labels: ["Paid total", "Unpaid total", "Partial total"],
      datasets: [
        {
          data: [pa.paid, pa.unpaid, pa.partial],
          backgroundColor: [palette[0], palette[5], palette[4]],
          borderWidth: 0,
        },
      ],
    },
    options: chartWithTitle("Revenue (₹) by status"),
  });
  chartInstances.push(doughnutAmt);

  const barMonthly = new Chart(document.getElementById("chart-monthly"), {
    type: "bar",
    data: {
      labels: a.monthly.labels,
      datasets: [
        {
          label: "Revenue (₹)",
          data: a.monthly.revenue,
          backgroundColor: palette[0],
          borderRadius: 4,
        },
      ],
    },
    options: chartWithTitleScales("Revenue by month (last 12)", {
      x: { ticks: { color: "#5c6562", maxRotation: 45 }, grid: { display: false } },
      y: { ticks: { color: "#5c6562" }, grid: { color: "rgba(0,0,0,0.06)" }, beginAtZero: true },
    }),
  });
  chartInstances.push(barMonthly);

  const lineDaily = new Chart(document.getElementById("chart-daily"), {
    type: "line",
    data: {
      labels: a.daily.labels,
      datasets: [
        {
          label: "Daily revenue (₹)",
          data: a.daily.revenue,
          borderColor: palette[1],
          backgroundColor: "rgba(45, 138, 110, 0.12)",
          fill: true,
          tension: 0.25,
          pointRadius: 2,
        },
      ],
    },
    options: chartWithTitleScales("Daily revenue (last 30 days)", {
      x: { ticks: { color: "#5c6562", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: { ticks: { color: "#5c6562" }, beginAtZero: true },
    }),
  });
  chartInstances.push(lineDaily);

  const top = a.topCustomers.slice(0, 8);
  const barTop = new Chart(document.getElementById("chart-customers"), {
    type: "bar",
    data: {
      labels: top.map((r) => (r.name.length > 22 ? `${r.name.slice(0, 20)}…` : r.name)),
      datasets: [
        {
          label: "₹ billed",
          data: top.map((r) => r.total),
          backgroundColor: palette[2],
          borderRadius: 4,
        },
      ],
    },
    options: chartWithTitleScales(
      "Top customers by billed amount",
      {
        x: { ticks: { color: "#5c6562" }, beginAtZero: true },
        y: { ticks: { color: "#5c6562", font: { size: 10 } } },
      },
      { indexAxis: "y" }
    ),
  });
  chartInstances.push(barTop);

  const tax = a.taxSplit;
  const pieTax = new Chart(document.getElementById("chart-tax"), {
    type: "pie",
    data: {
      labels: ["CGST", "SGST"],
      datasets: [
        {
          data: [tax.cgst, tax.sgst],
          backgroundColor: [palette[0], palette[3]],
          borderWidth: 0,
        },
      ],
    },
    options: chartWithTitle("GST split (all invoices)"),
  });
  chartInstances.push(pieTax);

  const pm = a.paymentMethods.length ? a.paymentMethods : [["credit_sale", 0]];
  const barMethods = new Chart(document.getElementById("chart-methods"), {
    type: "bar",
    data: {
      labels: pm.map(([k]) => paymentMethodLabel(k)),
      datasets: [
        {
          label: "Invoices",
          data: pm.map(([, v]) => v),
          backgroundColor: palette[1],
          borderRadius: 4,
        },
      ],
    },
    options: chartWithTitleScales("Invoices by payment method", {
      x: { ticks: { color: "#5c6562", maxRotation: 35 } },
      y: { ticks: { color: "#5c6562", stepSize: 1 }, beginAtZero: true },
    }),
  });
  chartInstances.push(barMethods);
}

function buildDetailTable(key, a) {
  const fmt = (n) => `₹ ${round2(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  switch (key) {
    case "kpis":
      return `<table class="dashboard-detail-table"><thead><tr><th>Metric</th><th class="num">Value</th></tr></thead><tbody>
        <tr><td>Total billed (invoice totals)</td><td class="num">${fmt(a.kpis.totalBilled)}</td></tr>
        <tr><td>Collected on invoices</td><td class="num">${fmt(a.kpis.totalCollected)}</td></tr>
        <tr><td>Outstanding (customers)</td><td class="num">${fmt(a.kpis.outstanding)}</td></tr>
        <tr><td>Invoice count</td><td class="num">${a.kpis.invoiceCount}</td></tr>
        <tr><td>Average invoice value</td><td class="num">${fmt(a.kpis.avgInvoice)}</td></tr>
        <tr><td>CGST total</td><td class="num">${fmt(a.kpis.totalCgst)}</td></tr>
        <tr><td>SGST total</td><td class="num">${fmt(a.kpis.totalSgst)}</td></tr>
      </tbody></table>`;
    case "payment-count": {
      const pc = a.paymentCount;
      const t = pc.paid + pc.unpaid + pc.partial;
      return `<table class="dashboard-detail-table"><thead><tr><th>Status</th><th class="num">Invoices</th><th class="num">Share</th></tr></thead><tbody>
        <tr><td>Paid</td><td class="num">${pc.paid}</td><td class="num">${t ? ((100 * pc.paid) / t).toFixed(1) : 0}%</td></tr>
        <tr><td>Unpaid</td><td class="num">${pc.unpaid}</td><td class="num">${t ? ((100 * pc.unpaid) / t).toFixed(1) : 0}%</td></tr>
        <tr><td>Partial</td><td class="num">${pc.partial}</td><td class="num">${t ? ((100 * pc.partial) / t).toFixed(1) : 0}%</td></tr>
      </tbody></table>`;
    }
    case "payment-amount": {
      const pa = a.paymentAmount;
      const t = pa.paid + pa.unpaid + pa.partial;
      return `<table class="dashboard-detail-table"><thead><tr><th>Status</th><th class="num">Amount (₹)</th><th class="num">Share</th></tr></thead><tbody>
        <tr><td>Paid</td><td class="num">${fmt(pa.paid)}</td><td class="num">${t ? ((100 * pa.paid) / t).toFixed(1) : 0}%</td></tr>
        <tr><td>Unpaid</td><td class="num">${fmt(pa.unpaid)}</td><td class="num">${t ? ((100 * pa.unpaid) / t).toFixed(1) : 0}%</td></tr>
        <tr><td>Partial</td><td class="num">${fmt(pa.partial)}</td><td class="num">${t ? ((100 * pa.partial) / t).toFixed(1) : 0}%</td></tr>
      </tbody></table>`;
    }
    case "monthly":
      return `<table class="dashboard-detail-table"><thead><tr><th>Month</th><th class="num">Revenue (₹)</th></tr></thead><tbody>${a.monthly.labels
        .map((lab, i) => `<tr><td>${escapeHtml(lab)}</td><td class="num">${fmt(a.monthly.revenue[i])}</td></tr>`)
        .join("")}</tbody></table>`;
    case "daily":
      return `<table class="dashboard-detail-table"><thead><tr><th>Day (dd/mm)</th><th class="num">Revenue (₹)</th></tr></thead><tbody>${a.daily.labels
        .map((lab, i) => `<tr><td>${escapeHtml(lab)}</td><td class="num">${fmt(a.daily.revenue[i])}</td></tr>`)
        .join("")}</tbody></table><p class="muted small">Last 30 days from today.</p>`;
    case "customers":
      return `<table class="dashboard-detail-table"><thead><tr><th>Customer</th><th class="num">Invoices</th><th class="num">Billed (₹)</th></tr></thead><tbody>${a.topCustomers
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.count}</td><td class="num">${fmt(r.total)}</td></tr>`
        )
        .join("")}</tbody></table>`;
    case "tax":
      return `<table class="dashboard-detail-table"><thead><tr><th>Tax</th><th class="num">Amount (₹)</th></tr></thead><tbody>
        <tr><td>CGST (sum)</td><td class="num">${fmt(a.taxSplit.cgst)}</td></tr>
        <tr><td>SGST (sum)</td><td class="num">${fmt(a.taxSplit.sgst)}</td></tr>
        <tr><td><strong>Total GST</strong></td><td class="num"><strong>${fmt(a.kpis.taxTotal)}</strong></td></tr>
      </tbody></table>`;
    case "methods":
      return `<table class="dashboard-detail-table"><thead><tr><th>Method</th><th class="num">Invoices</th></tr></thead><tbody>${a.paymentMethods
        .map(([k, v]) => `<tr><td>${escapeHtml(paymentMethodLabel(k))}</td><td class="num">${v}</td></tr>`)
        .join("")}</tbody></table>`;
    default:
      return "<p>No details.</p>";
  }
}

const detailTitles = {
  kpis: "Key metrics — full breakdown",
  "payment-count": "Payment status — invoice counts",
  "payment-amount": "Payment status — revenue split",
  monthly: "Monthly revenue — detail",
  daily: "Daily revenue — detail",
  customers: "Customers — billed totals",
  tax: "GST (CGST / SGST) — detail",
  methods: "Payment methods — detail",
};

function openDashboardDetail(key) {
  if (!lastAnalytics || !Chart) return;
  const modal = document.getElementById("dashboard-detail-modal");
  const titleEl = document.getElementById("dashboard-detail-title");
  const bodyEl = document.getElementById("dashboard-detail-body");
  if (!modal || !titleEl || !bodyEl) return;

  const titleTextEl = document.getElementById("dashboard-detail-title-text");
  const label = detailTitles[key] || "Details";
  if (titleTextEl) titleTextEl.textContent = label;
  else titleEl.textContent = label;

  if (modalChart) {
    try {
      modalChart.destroy();
    } catch (_) {}
    modalChart = null;
  }

  if (key === "kpis") {
    bodyEl.innerHTML = `<div class="dashboard-detail-scroll">${buildDetailTable("kpis", lastAnalytics)}</div>`;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    return;
  }

  bodyEl.innerHTML = `<div class="dashboard-detail-chart-wrap"><canvas id="dashboard-detail-canvas-inner"></canvas></div><div class="dashboard-detail-scroll">${buildDetailTable(key, lastAnalytics)}</div>`;

  const inner = document.getElementById("dashboard-detail-canvas-inner");
  if (!inner) return;

  const a = lastAnalytics;
  const palette = ["#1a5f4a", "#2d8a6e", "#4a9d7e", "#0d6e4d", "#f59e0b", "#b42318"];

  if (key === "payment-count") {
    const pc = a.paymentCount;
    modalChart = new Chart(inner, {
      type: "doughnut",
      data: {
        labels: ["Paid", "Unpaid", "Partial"],
        datasets: [{ data: [pc.paid, pc.unpaid, pc.partial], backgroundColor: [palette[0], palette[5], palette[4]] }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
    });
  } else if (key === "payment-amount") {
    const pa = a.paymentAmount;
    modalChart = new Chart(inner, {
      type: "doughnut",
      data: {
        labels: ["Paid", "Unpaid", "Partial"],
        datasets: [{ data: [pa.paid, pa.unpaid, pa.partial], backgroundColor: [palette[0], palette[5], palette[4]] }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
    });
  } else if (key === "monthly") {
    modalChart = new Chart(inner, {
      type: "bar",
      data: {
        labels: a.monthly.labels,
        datasets: [{ label: "Revenue", data: a.monthly.revenue, backgroundColor: palette[0], borderRadius: 4 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
      },
    });
  } else if (key === "daily") {
    modalChart = new Chart(inner, {
      type: "line",
      data: {
        labels: a.daily.labels,
        datasets: [
          {
            data: a.daily.revenue,
            borderColor: palette[1],
            backgroundColor: "rgba(45, 138, 110, 0.15)",
            fill: true,
            tension: 0.25,
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });
  } else if (key === "customers") {
    const top = a.topCustomers.slice(0, 10);
    modalChart = new Chart(inner, {
      type: "bar",
      data: {
        labels: top.map((r) => r.name),
        datasets: [{ label: "₹", data: top.map((r) => r.total), backgroundColor: palette[2], borderRadius: 4 }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { beginAtZero: true } },
      },
    });
  } else if (key === "tax") {
    modalChart = new Chart(inner, {
      type: "pie",
      data: {
        labels: ["CGST", "SGST"],
        datasets: [{ data: [a.taxSplit.cgst, a.taxSplit.sgst], backgroundColor: [palette[0], palette[3]] }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (key === "methods") {
    const pm = a.paymentMethods;
    modalChart = new Chart(inner, {
      type: "bar",
      data: {
        labels: pm.map(([k]) => paymentMethodLabel(k)),
        datasets: [{ data: pm.map(([, v]) => v), backgroundColor: palette[1], borderRadius: 4 }],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeDashboardDetail() {
  const modal = document.getElementById("dashboard-detail-modal");
  if (modalChart) {
    try {
      modalChart.destroy();
    } catch (_) {}
    modalChart = null;
  }
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 */
export async function mountDashboard(db, uid) {
  const root = document.getElementById("dashboard-root");
  if (!root) return;

  lastDashboardMount = { db, uid };

  destroyCharts();

  let invoices;
  let customers;
  try {
    [invoices, customers] = await Promise.all([listInvoicesForUser(db, uid), listCustomers(db, uid)]);
  } catch (ex) {
    const msg =
      ex && ex.code === "permission-denied"
        ? "Could not load dashboard data. Check Firestore rules."
        : ex && ex.message
          ? String(ex.message)
          : "Could not load dashboard.";
    root.innerHTML = `<div class="card dashboard-error"><p class="muted">${escapeHtml(msg)}</p><p class="small"><a href="#/history">Invoice register</a> · <a href="#/settings">Business settings</a></p></div>`;
    console.error("[mountDashboard]", ex);
    return;
  }

  let a;
  try {
    a = computeAnalytics(invoices, customers);
  } catch (ex) {
    root.innerHTML = `<div class="card dashboard-error"><p class="muted">Could not compute analytics.</p></div>`;
    console.error("[computeAnalytics]", ex);
    return;
  }
  lastAnalytics = a;

  const k = a.kpis;
  const empty = a.rawInvoiceCount === 0;

  let quickStrip = "";
  try {
    const openQo = await listOpenQuickOrders(db, uid);
    quickStrip = buildQuickOrdersDashboardStrip(openQo);
  } catch (e) {
    console.warn("[mountDashboard] quick orders", e);
  }

  root.innerHTML = `${quickStrip}
    <div class="dashboard-toolbar">
      <p class="muted dashboard-lead">GST billing overview — revenue, receivables, payment mix, and trends. Click any card or chart for the full breakdown.</p>
      <div class="btn-row wrap">
        <a class="btn btn-primary" href="#/create">New GST invoice</a>
        <a class="btn btn-secondary" href="#/quick-orders">Quick order</a>
        <a class="btn btn-secondary" href="#/customers">Customers</a>
        <a class="btn btn-secondary" href="#/history">Invoice register</a>
        <a class="btn btn-secondary" href="#/settings">Business settings</a>
      </div>
    </div>

    <div class="dashboard-kpi-strip" data-dashboard-detail="kpis" role="button" tabindex="0" title="Click for full metrics">
      ${buildKpiCard("Total billed", `₹ ${k.totalBilled.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "Sum of all invoice totals", "")}
      ${buildKpiCard("Collected", `₹ ${k.totalCollected.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "Recorded on invoices", "accent")}
      ${buildKpiCard("Outstanding", `₹ ${k.outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "From customer balances", "warn")}
      ${buildKpiCard("Invoices", String(k.invoiceCount), `Avg ₹ ${k.avgInvoice.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "")}
      ${buildKpiCard("CGST", `₹ ${k.totalCgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "Summed from invoices", "")}
      ${buildKpiCard("SGST", `₹ ${k.totalSgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, "Summed from invoices", "")}
    </div>

    <div id="dashboard-charts-slot" class="dashboard-charts ${empty ? "dashboard-charts--empty" : ""}">
      ${
        empty
          ? `<div class="dashboard-empty card"><p><strong>No invoices yet.</strong> Create your first GST invoice to see revenue charts, payment mix, and trends.</p><a class="btn btn-primary" href="#/create">New GST invoice</a></div>`
          : `
      <div class="dashboard-grid">
        <article class="dashboard-chart-card card" data-dashboard-detail="payment-count" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas"><canvas id="chart-payment-count" height="220"></canvas></div>
        </article>
        <article class="dashboard-chart-card card" data-dashboard-detail="payment-amount" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas"><canvas id="chart-payment-amount" height="220"></canvas></div>
        </article>
        <article class="dashboard-chart-card card dashboard-chart-card--wide" data-dashboard-detail="monthly" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas dashboard-chart-canvas--wide"><canvas id="chart-monthly" height="260"></canvas></div>
        </article>
        <article class="dashboard-chart-card card dashboard-chart-card--wide" data-dashboard-detail="daily" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas dashboard-chart-canvas--wide"><canvas id="chart-daily" height="240"></canvas></div>
        </article>
        <article class="dashboard-chart-card card" data-dashboard-detail="customers" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas"><canvas id="chart-customers" height="280"></canvas></div>
        </article>
        <article class="dashboard-chart-card card" data-dashboard-detail="tax" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas"><canvas id="chart-tax" height="220"></canvas></div>
        </article>
        <article class="dashboard-chart-card card dashboard-chart-card--wide" data-dashboard-detail="methods" tabindex="0" role="button">
          <span class="dashboard-chart-hint">Click to expand</span>
          <div class="dashboard-chart-canvas dashboard-chart-canvas--wide"><canvas id="chart-methods" height="220"></canvas></div>
        </article>
      </div>`
      }
    </div>
  `;

  if (!empty) {
    try {
      renderChartsInRoot(root, a);
    } catch (ex) {
      const slot = root.querySelector("#dashboard-charts-slot");
      if (slot) {
        slot.innerHTML = `<p class="muted">Charts could not be drawn. Try refreshing the page.</p>`;
      }
      console.error("[dashboard charts]", ex);
    }
  }

  root.onclick = (e) => {
    const dismiss = e.target.closest(".dashboard-qo-dismiss");
    if (dismiss) {
      e.preventDefault();
      e.stopPropagation();
      const id = dismiss.getAttribute("data-id");
      const { db: d, uid: u } = lastDashboardMount;
      if (!id || !d || !u) return;
      (async () => {
        try {
          await markQuickOrderDone(d, id, u);
          showToast("Marked as done.");
          await mountDashboard(d, u);
        } catch (ex) {
          showToast(ex?.message || "Could not update.", { type: "error" });
        }
      })();
      return;
    }
    if (e.target.closest(".dashboard-qo-create-link")) return;
    const qoCard = e.target.closest(".dashboard-qo-item-card");
    if (qoCard) {
      const id = qoCard.getAttribute("data-qo-id");
      const { db: d, uid: u } = lastDashboardMount;
      if (id && d && u) openDashboardQuickOrderModal(d, u, id);
      return;
    }
    const card = e.target.closest("[data-dashboard-detail]");
    if (!card) return;
    const key = card.dataset.dashboardDetail;
    if (key) openDashboardDetail(key);
  };

  root.onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const qoCard = e.target.closest(".dashboard-qo-item-card");
    if (qoCard) {
      e.preventDefault();
      const id = qoCard.getAttribute("data-qo-id");
      const { db: d, uid: u } = lastDashboardMount;
      if (id && d && u) openDashboardQuickOrderModal(d, u, id);
      return;
    }
    const card = e.target.closest("[data-dashboard-detail]");
    if (!card) return;
    e.preventDefault();
    const key = card.dataset.dashboardDetail;
    if (key) openDashboardDetail(key);
  };

  const closeBtn = document.getElementById("dashboard-detail-close");
  const backdrop = document.getElementById("dashboard-detail-backdrop");
  if (closeBtn && !closeBtn._dashBound) {
    closeBtn._dashBound = true;
    closeBtn.addEventListener("click", closeDashboardDetail);
  }
  if (backdrop && !backdrop._dashBound) {
    backdrop._dashBound = true;
    backdrop.addEventListener("click", closeDashboardDetail);
  }

  if (!document.body.dataset.dashboardEscBound) {
    document.body.dataset.dashboardEscBound = "1";
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const qoModal = document.getElementById("dashboard-qo-modal");
      if (qoModal && !qoModal.classList.contains("hidden")) {
        closeDashboardQuickOrderModal();
        return;
      }
      const modal = document.getElementById("dashboard-detail-modal");
      if (modal && !modal.classList.contains("hidden")) closeDashboardDetail();
    });
  }
}

export { closeDashboardDetail, closeDashboardQuickOrderModal };
