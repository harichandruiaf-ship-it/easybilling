const ones = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ones[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return tens[t] + (o ? ` ${ones[o]}` : "");
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let s = "";
  if (h) s = `${ones[h]} Hundred`;
  if (rest) s += (s ? " " : "") + twoDigits(rest);
  return s.trim();
}

/**
 * Converts a non-negative number to Indian English words (Rupees).
 * @param {number} amount
 * @returns {string}
 */
export function amountToWordsIn(amount) {
  if (typeof amount !== "number" || Number.isNaN(amount) || amount < 0) {
    return "Zero Rupees Only";
  }

  const rounded = Math.round(amount * 100) / 100;
  const rupees = Math.floor(rounded + 1e-9);
  const paise = Math.round((rounded - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Zero Rupees Only";

  const parts = [];

  let n = rupees;
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = n;

  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));

  let rupeeStr = parts.length ? parts.join(" ") : "Zero";
  rupeeStr += rupees === 1 ? " Rupee" : " Rupees";

  if (paise > 0) {
    rupeeStr += ` and ${twoDigits(paise)} Paise`;
  }

  return `${rupeeStr} Only`;
}
