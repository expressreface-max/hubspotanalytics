import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"

// Transpile only this dependency-free helper; no app secrets or server imports.
const source = readFileSync(new URL("../lib/date-ranges.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const { resolveRange, toDateInput, defaultCustomRange, RANGE_OPTIONS } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const now = new Date("2026-11-01T13:33:00Z")
const range = (key, at = now, custom) => resolveRange(key, custom, at)

test("October 31 regression: Pacific yesterday excludes the three Friday-evening contacts", () => {
  assert.deepEqual(range("yesterday"), {
    dateFrom: "2026-10-31T07:00:00.000Z", dateTo: "2026-11-01T06:59:59.999Z",
  })
  const records = [
    "2026-10-31T03:56:13.212Z", "2026-10-31T04:40:36.486Z", "2026-10-31T05:47:21.355Z",
    "2026-10-31T13:21:44.326Z", "2026-10-31T17:38:10.343Z",
    "2026-10-31T20:09:23.366Z", "2026-10-31T23:02:09.230Z",
  ]
  const { dateFrom, dateTo } = range("yesterday")
  assert.equal(records.filter(d => d >= dateFrom && d <= dateTo).length, 4)
})

for (const [name, at, from, to, hours] of [
  ["spring forward", "2026-03-09T12:00:00Z", "2026-03-08T08:00:00.000Z", "2026-03-09T06:59:59.999Z", 23],
  ["fall back", "2026-11-02T12:00:00Z", "2026-11-01T07:00:00.000Z", "2026-11-02T07:59:59.999Z", 25],
]) {
  test(`${name}: complete Pacific day`, () => {
    const actual = range("yesterday", new Date(at))
    assert.deepEqual(actual, { dateFrom: from, dateTo: to })
    assert.equal((Date.parse(to) - Date.parse(from) + 1) / 3600000, hours)
  })
}
test("Pacific calendar date is used even when UTC has advanced to the next year", () => {
  const at = new Date("2027-01-01T03:00:00Z")
  assert.equal(toDateInput(at), "2026-12-31")
  assert.equal(range("ytd", at).dateFrom, "2026-01-01T08:00:00.000Z")
  assert.equal(range("mtd", at).dateFrom, "2026-12-01T08:00:00.000Z")
})
test("Monday weeks and preceding full week", () => {
  const at = new Date("2026-11-02T12:00:00Z")
  assert.equal(range("thisWeek", at).dateFrom, "2026-11-02T08:00:00.000Z")
  assert.deepEqual(range("lastWeek", at), {
    dateFrom: "2026-10-26T07:00:00.000Z", dateTo: "2026-11-02T07:59:59.999Z",
  })
})
test("month and year boundaries include the final millisecond", () => {
  assert.deepEqual(range("lastMonth"), {
    dateFrom: "2026-10-01T07:00:00.000Z", dateTo: "2026-11-01T06:59:59.999Z",
  })
  assert.deepEqual(range("lastYear"), {
    dateFrom: "2025-01-01T08:00:00.000Z", dateTo: "2026-01-01T07:59:59.999Z",
  })
})
test("custom dates use Pacific boundaries including DST and inverted input", () => {
  const expected = { dateFrom: "2026-10-31T07:00:00.000Z", dateTo: "2026-11-02T07:59:59.999Z" }
  assert.deepEqual(range("custom", now, { from: "2026-10-31", to: "2026-11-01" }), expected)
  assert.deepEqual(range("custom", now, { from: "2026-11-01", to: "2026-10-31" }), expected)
  assert.deepEqual(defaultCustomRange(now), { from: "2026-10-02", to: "2026-11-01" })
})
test("prior year comparisons clamp leap day rather than spilling into March", () => {
  const at = new Date("2024-02-29T20:00:00Z")
  assert.equal(range("lastYearYtd", at).dateTo, "2023-03-01T07:59:59.999Z")
  assert.equal(range("last12", at).dateFrom, "2023-02-28T08:00:00.000Z")
})
test("all presets are valid and independent of host timezone", () => {
  const before = process.env.TZ
  try {
    const baseline = RANGE_OPTIONS.map(({ key }) => range(key))
    for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = timezone
      assert.deepEqual(RANGE_OPTIONS.map(({ key }) => range(key)), baseline)
    }
    for (const value of baseline) assert.ok(Date.parse(value.dateFrom) <= Date.parse(value.dateTo))
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})
test("daily schedule runs after Pacific midnight in both seasons", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))
  assert.equal(config.crons.find(c => c.path === "/api/cron/sales-manager").schedule, "1 8 * * *")
  assert.equal(toDateInput(new Date("2026-11-02T08:01:00Z")), "2026-11-02")
  assert.equal(toDateInput(new Date("2026-07-02T08:01:00Z")), "2026-07-02")
})
