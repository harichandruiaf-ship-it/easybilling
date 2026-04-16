/**
 * Period-scoped billing analytics for the Reports module (filters + time buckets).
 * Pure functions — safe to unit test; dashboard `computeAnalytics` stays unchanged.
 */
import { accountPeriodLabelForInvoice, round2 } from "./invoices.js";

function invoiceDate(d) {
  if (!d) return null;
  if (typeof d.toDate === "function") return d.toDate();
  if (d instanceof Date) return d;
  return null;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Monday 00:00:00 local (week = Mon–Sun). */
function mondayOfWeek(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function sundayEndOfWeekFromMonday(monday) {
  const dt = new Date(monday);
  dt.setDate(dt.getDate() + 6);
  dt.setHours(23, 59, 59, 999);
  return dt;
}

function startOfQuarter(d) {
  const m = d.getMonth();
  const qStartMonth = Math.floor(m / 3) * 3;
  return startOfDay(new Date(d.getFullYear(), qStartMonth, 1));
}

function endOfQuarter(d) {
  const s = startOfQuarter(d);
  const e = new Date(s.getFullYear(), s.getMonth() + 3, 0);
  return endOfDay(e);
}

/** India FY: 1 Apr – 31 Mar. */
function currentIndiaFYBounds(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const startYear = m >= 3 ? y : y - 1;
  const start = startOfDay(new Date(startYear, 3, 1));
  const end = endOfDay(new Date(startYear + 1, 2, 31));
  return { start, end };
}

/**
 * @typedef {"today"|"yesterday"|"this_week"|"this_month"|"this_quarter"|"this_year"|"this_fy_india"|"custom"} ReportPeriodPreset
 */

/**
 * @param {ReportPeriodPreset} preset
 * @param {{ from?: string, to?: string }} custom - yyyy-mm-dd from date inputs
 * @returns {{ start: Date, end: Date, label: string }}
 */
export function getPeriodBounds(preset, custom = {}) {
  const now = new Date();
  switch (preset) {
    case "today": {
      const s = startOfDay(now);
      const e = endOfDay(now);
      return { start: s, end: e, label: "Today" };
    }
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { start: startOfDay(y), end: endOfDay(y), label: "Yesterday" };
    }
    case "this_week": {
      const mon = mondayOfWeek(now);
      const sun = sundayEndOfWeekFromMonday(mon);
      return { start: mon, end: sun, label: "This week" };
    }
    case "this_month": {
      const s = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
      const e = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      return { start: s, end: e, label: "This month" };
    }
    case "this_quarter": {
      return {
        start: startOfQuarter(now),
        end: endOfQuarter(now),
        label: "This quarter",
      };
    }
    case "this_year": {
      const s = startOfDay(new Date(now.getFullYear(), 0, 1));
      const e = endOfDay(new Date(now.getFullYear(), 11, 31));
      return { start: s, end: e, label: "This year" };
    }
    case "this_fy_india": {
      const { start, end } = currentIndiaFYBounds(now);
      return { start, end, label: "Current FY (India)" };
    }
    case "custom": {
      const fromStr = (custom.from || "").trim();
      const toStr = (custom.to || "").trim();
      if (!fromStr || !toStr) {
        const s = startOfDay(now);
        const e = endOfDay(now);
        return { start: s, end: e, label: "Custom (invalid range — showing today)" };
      }
      const fromParts = fromStr.split("-").map(Number);
      const toParts = toStr.split("-").map(Number);
      if (fromParts.length !== 3 || toParts.length !== 3 || fromParts.some((n) => Number.isNaN(n)) || toParts.some((n) => Number.isNaN(n))) {
        const s = startOfDay(now);
        const e = endOfDay(now);
        return { start: s, end: e, label: "Custom (invalid dates — showing today)" };
      }
      const s = startOfDay(new Date(fromParts[0], fromParts[1] - 1, fromParts[2]));
      const e = endOfDay(new Date(toParts[0], toParts[1] - 1, toParts[2]));
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
        const sd = startOfDay(now);
        const ed = endOfDay(now);
        return { start: sd, end: ed, label: "Custom (invalid dates — showing today)" };
      }
      if (s > e) {
        return { start: e, end: s, label: "Custom" };
      }
      return { start: s, end: e, label: "Custom range" };
    }
    default: {
      const s = startOfDay(now);
      const e = endOfDay(now);
      return { start: s, end: e, label: "Today" };
    }
  }
}

function inRange(d, start, end) {
  if (!d || Number.isNaN(d.getTime())) return false;
  return d >= start && d <= end;
}

/**
 * @param {Array<object>} invoices
 * @param {{ start: Date, end: Date, customerId?: string, paymentStatus?: string, accountPeriod?: string }} filters
 */
export function filterInvoicesForReport(invoices, filters) {
  const { start, end } = filters;
  const cust = (filters.customerId || "").trim();
  const pst = (filters.paymentStatus || "").trim().toLowerCase();
  const ap = (filters.accountPeriod || "").trim();

  return (Array.isArray(invoices) ? invoices : []).filter((inv) => {
    const id = inv.customerId || "";
    const d = invoiceDate(inv.date);
    if (!inRange(d, start, end)) return false;
    if (cust && id !== cust) return false;
    if (pst) {
      const st = String(inv.paymentStatus || "unpaid").toLowerCase();
      if (st !== pst) return false;
    }
    if (ap && accountPeriodLabelForInvoice(inv) !== ap) return false;
    return true;
  });
}

/** Daily | weekly | monthly buckets based on span length. */
function bucketMode(start, end) {
  const ms = end.getTime() - start.getTime();
  const days = Math.ceil(ms / 86400000) + 1;
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

function weekKeyMonday(d) {
  const mon = mondayOfWeek(d);
  return localDateKey(mon);
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Local calendar date yyyy-mm-dd (avoids UTC shift in charts). */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param {Array<object>} filteredInvoices
 * @param {Array<object>} customers - for outstanding (optional; all-time from customer docs)
 * @param {{ start: Date, end: Date }} range
 */
export function computeReportAnalytics(filteredInvoices, customers, range) {
  const { start, end } = range || {};
  if (
    !start ||
    !end ||
    !(start instanceof Date) ||
    !(end instanceof Date) ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return {
      kpis: {
        totalBilled: 0,
        totalCollected: 0,
        invoiceCount: 0,
        avgInvoice: 0,
        outstanding: 0,
        totalCgst: 0,
        totalSgst: 0,
        taxTotal: 0,
      },
      paymentCount: { paid: 0, unpaid: 0, partial: 0 },
      paymentAmount: { paid: 0, unpaid: 0, partial: 0 },
      taxSplit: { cgst: 0, sgst: 0 },
      series: { labels: [], revenue: [], bucketMode: "day" },
      topCustomers: [],
      paymentMethods: [],
      topInvoiceRows: [],
      rawInvoiceCount: 0,
    };
  }

  const rows = Array.isArray(filteredInvoices) ? filteredInvoices : [];

  let totalBilled = 0;
  let totalCollected = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  const paymentCount = { paid: 0, unpaid: 0, partial: 0 };
  const paymentAmount = { paid: 0, unpaid: 0, partial: 0 };

  const byCustomer = new Map();
  const bucketTotals = new Map();
  const mode = bucketMode(start, end);

  for (const inv of rows) {
    const t = round2(Number(inv.total) || 0);
    const paid = round2(Number(inv.amountPaidOnInvoice) || 0);
    const st = String(inv.paymentStatus || "unpaid").toLowerCase();

    totalBilled += t;
    totalCollected += paid;
    totalCgst += round2(Number(inv.cgst) || 0);
    totalSgst += round2(Number(inv.sgst) || 0);
    totalIgst += round2(Number(inv.igst) || 0);

    if (st === "paid") {
      paymentCount.paid += 1;
      paymentAmount.paid += t;
    } else if (st === "partial") {
      paymentCount.partial += 1;
      paymentAmount.partial += t;
    } else {
      paymentCount.unpaid += 1;
      paymentAmount.unpaid += t;
    }

    const d = invoiceDate(inv.date);
    if (d) {
      let key;
      if (mode === "day") {
        key = localDateKey(d);
      } else if (mode === "week") {
        key = weekKeyMonday(d);
      } else {
        key = monthKey(d);
      }
      bucketTotals.set(key, round2((bucketTotals.get(key) || 0) + t));
    }

    const ckey = inv.customerId || inv.customerName || "_walkin";
    const name = (inv.customerName || "").trim() || "Walk-in / no name";
    const cur = byCustomer.get(ckey) || { key: ckey, name, total: 0, count: 0 };
    cur.total = round2(cur.total + t);
    cur.count += 1;
    byCustomer.set(ckey, cur);
  }

  let outstandingFromCustomers = 0;
  for (const c of customers || []) {
    outstandingFromCustomers += round2(Number(c.outstandingBalance) || 0);
  }

  const topCustomers = [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, 10);

  const seriesLabels = [];
  const seriesData = [];
  if (mode === "day") {
    const cur = new Date(start);
    cur.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);
    while (cur <= endDay) {
      const key = localDateKey(cur);
      seriesLabels.push(
        `${String(cur.getDate()).padStart(2, "0")}/${String(cur.getMonth() + 1).padStart(2, "0")}`
      );
      seriesData.push(round2(bucketTotals.get(key) || 0));
      cur.setDate(cur.getDate() + 1);
    }
  } else if (mode === "week") {
    let cur = mondayOfWeek(start);
    const endT = end.getTime();
    while (cur.getTime() <= endT) {
      const key = localDateKey(cur);
      seriesLabels.push(
        `${String(cur.getDate()).padStart(2, "0")}/${String(cur.getMonth() + 1).padStart(2, "0")}`
      );
      seriesData.push(round2(bucketTotals.get(key) || 0));
      cur = new Date(cur);
      cur.setDate(cur.getDate() + 7);
    }
  } else {
    let y = start.getFullYear();
    let m = start.getMonth();
    const endY = end.getFullYear();
    const endM = end.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      const d = new Date(y, m, 1);
      seriesLabels.push(d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }));
      seriesData.push(round2(bucketTotals.get(key) || 0));
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }

  const byMethod = new Map();
  for (const inv of rows) {
    const m = String(inv.paymentMethod || "credit_sale").trim() || "credit_sale";
    byMethod.set(m, (byMethod.get(m) || 0) + 1);
  }
  const paymentMethods = [...byMethod.entries()].sort((a, b) => b[1] - a[1]);

  const n = rows.length;
  const topInvoiceRows = rows
    .slice()
    .sort((a, b) => {
      const da = invoiceDate(a.date)?.getTime() || 0;
      const db = invoiceDate(b.date)?.getTime() || 0;
      return db - da;
    })
    .slice(0, 25);

  return {
    kpis: {
      totalBilled: round2(totalBilled),
      totalCollected: round2(totalCollected),
      invoiceCount: n,
      avgInvoice: n ? round2(totalBilled / n) : 0,
      outstanding: round2(outstandingFromCustomers),
      totalCgst: round2(totalCgst),
      totalSgst: round2(totalSgst),
      totalIgst: round2(totalIgst),
      taxTotal: round2(totalCgst + totalSgst + totalIgst),
    },
    paymentCount,
    paymentAmount,
    taxSplit: { cgst: round2(totalCgst), sgst: round2(totalSgst), igst: round2(totalIgst) },
    series: { labels: seriesLabels, revenue: seriesData, bucketMode: mode },
    topCustomers,
    paymentMethods,
    topInvoiceRows,
    rawInvoiceCount: n,
  };
}
