import { round2 } from "./invoices.js";

function invoiceDate(d) {
  if (!d) return null;
  if (typeof d.toDate === "function") return d.toDate();
  if (d instanceof Date) return d;
  return null;
}

/** Local calendar YYYY-MM-DD (must match chart day labels — do not use toISOString, it is UTC). */
function localYmd(d) {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * @param {Array<object>} invoices - rows from listInvoicesForUser
 * @param {Array<object>} customers - from listCustomers
 */
export function computeAnalytics(invoices, customers) {
  const now = new Date();
  const rows = Array.isArray(invoices) ? invoices : [];

  let totalBilled = 0;
  let totalCollected = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  const paymentCount = { paid: 0, unpaid: 0, partial: 0 };
  const paymentAmount = { paid: 0, unpaid: 0, partial: 0 };

  const byCustomer = new Map();
  const byMonth = new Map();
  const byDay = new Map();

  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const chartStartLocal = new Date(todayLocal);
  chartStartLocal.setDate(chartStartLocal.getDate() - 29);
  const dailyWindowStartKey = localYmd(chartStartLocal);
  const dailyWindowEndKey = localYmd(todayLocal);

  for (const inv of rows) {
    const t = round2(Number(inv.total) || 0);
    const paid = round2(Number(inv.amountPaidOnInvoice) || 0);
    const st = String(inv.paymentStatus || "unpaid").toLowerCase();

    totalBilled += t;
    totalCollected += paid;
    totalCgst += round2(Number(inv.cgst) || 0);
    totalSgst += round2(Number(inv.sgst) || 0);

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
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      byMonth.set(monthKey, round2((byMonth.get(monthKey) || 0) + t));

      const dk = localYmd(d);
      if (dk && dk >= dailyWindowStartKey && dk <= dailyWindowEndKey) {
        byDay.set(dk, round2((byDay.get(dk) || 0) + t));
      }
    }

    const key = inv.customerId || inv.customerName || "_walkin";
    const name = (inv.customerName || "").trim() || "Walk-in / no name";
    const cur = byCustomer.get(key) || { key, name, total: 0, count: 0 };
    cur.total = round2(cur.total + t);
    cur.count += 1;
    byCustomer.set(key, cur);
  }

  let outstandingFromCustomers = 0;
  for (const c of customers || []) {
    outstandingFromCustomers += round2(Number(c.outstandingBalance) || 0);
  }

  const topCustomers = [...byCustomer.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const monthlyLabels = [];
  const monthlyData = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyLabels.push(
      d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
    );
    monthlyData.push(round2(byMonth.get(key) || 0));
  }

  const dailyLabels = [];
  const dailyData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayLocal);
    d.setDate(d.getDate() - i);
    const dayKey = localYmd(d);
    dailyLabels.push(`${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`);
    dailyData.push(round2((dayKey && byDay.get(dayKey)) || 0));
  }

  const byMethod = new Map();
  for (const inv of rows) {
    const m = String(inv.paymentMethod || "credit_sale").trim() || "credit_sale";
    byMethod.set(m, (byMethod.get(m) || 0) + 1);
  }
  const paymentMethods = [...byMethod.entries()].sort((a, b) => b[1] - a[1]);

  const n = rows.length;
  return {
    kpis: {
      totalBilled: round2(totalBilled),
      totalCollected: round2(totalCollected),
      invoiceCount: n,
      avgInvoice: n ? round2(totalBilled / n) : 0,
      outstanding: round2(outstandingFromCustomers),
      totalCgst: round2(totalCgst),
      totalSgst: round2(totalSgst),
      taxTotal: round2(totalCgst + totalSgst),
    },
    paymentCount,
    paymentAmount,
    taxSplit: { cgst: round2(totalCgst), sgst: round2(totalSgst) },
    monthly: { labels: monthlyLabels, revenue: monthlyData },
    daily: { labels: dailyLabels, revenue: dailyData },
    topCustomers,
    paymentMethods,
    rawInvoiceCount: rows.length,
  };
}
