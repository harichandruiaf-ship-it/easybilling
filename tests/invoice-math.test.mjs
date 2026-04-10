import test from "node:test";
import assert from "node:assert/strict";
import {
  round2,
  roundOffRupee,
  computeTotals,
  computeTotalsInterState,
} from "../js/invoice-math.js";

test("round2 two decimal places", () => {
  assert.equal(round2(10.456), 10.46);
  assert.equal(round2(10.444), 10.44);
});

test("roundOffRupee: fraction below 0.5 floors", () => {
  assert.equal(roundOffRupee(100.49), 100);
});

test("roundOffRupee: fraction above 0.5 ceils", () => {
  assert.equal(roundOffRupee(100.51), 101);
});

test("roundOffRupee: exactly 0.5 rounds up", () => {
  assert.equal(roundOffRupee(100.5), 101);
});

test("computeTotals intra: CGST + SGST on subtotal", () => {
  const t = computeTotals(1000, 2.5, 2.5);
  assert.equal(t.supplyType, "intra");
  assert.equal(t.subtotal, 1000);
  assert.equal(t.igst, 0);
  assert.equal(t.cgst + t.sgst + t.subtotal, t.total);
});

test("computeTotalsInterState: IGST rate is sum of component percents", () => {
  const t = computeTotalsInterState(1000, 2.5, 2.5);
  assert.equal(t.supplyType, "inter");
  assert.equal(t.igstPercent, 5);
  assert.equal(t.cgst, 0);
  assert.equal(t.sgst, 0);
  assert.equal(t.subtotal + t.igst, t.total);
});
