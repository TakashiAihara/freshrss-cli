import { expect, test } from "bun:test";
import { UsageError } from "../src/errors.ts";
import { unixSeconds } from "../src/time.ts";

test("digits are Unix seconds, even when they look like a year or a compact date", () => {
  expect(unixSeconds("1790000000", "--x")).toBe(1790000000);
  expect(unixSeconds("2026", "--x")).toBe(2026);
  expect(unixSeconds("20261004", "--x")).toBe(20261004);
});

test("an ISO date is UTC midnight", () => {
  expect(unixSeconds("2026-10-04", "--x")).toBe(Date.UTC(2026, 9, 4) / 1000);
});

test("an ISO date-time needs Z or an offset", () => {
  expect(unixSeconds("2026-10-04T10:30:00+09:00", "--x")).toBe(Date.UTC(2026, 9, 4, 1, 30) / 1000);
  expect(unixSeconds("2026-10-04T00:00Z", "--x")).toBe(Date.UTC(2026, 9, 4) / 1000);
  expect(() => unixSeconds("2026-10-04T09:00:00", "--x")).toThrow(UsageError);
});

test("anything else is a usage error", () => {
  for (const v of ["yesterday", "Oct 4 2026", "", "2026-13-01", "2026-02-30", "-5"]) {
    expect(() => unixSeconds(v, "--x")).toThrow(UsageError);
  }
});
