// The graphql-free half of CSV uploads (issue #81): reading a file under its
// limits, and which models take uploads at all. The writes themselves are
// exercised end to end by gqlize's `mutation-csv` and nestize's `csv` suites.
import {describe, it, expect} from "@jest/globals";

import {readCsv} from "../src/csv/read";
import {resolveCsvLimits, DEFAULT_CSV_LIMITS} from "../src/csv/limits";
import {csvCellValue} from "../src/csv/cells";
import {CsvUploadError} from "../src/csv/errors";
import {DataTypes} from "@azerothian/utilize/types/index";

const LIMITS = {maxRows: 10, maxBytes: 1024};

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CsvUploadError);
  return error as CsvUploadError;
}

describe("readCsv", () => {
  it("splits the header from the records, leaving empty cells out and reading \\N as null", async() => {
    const table = await readCsv(" name , note \r\na,\\N\r\n\r\nb,\r\n", LIMITS);
    expect(table.header).toEqual(["name", "note"]);
    expect(table.records).toEqual([
      {row: 1, cells: {name: "a", note: null}},
      {row: 2, cells: {name: "b"}},
    ]);
  });

  it("reads bytes, chunked streams and web streams alike", async() => {
    const bytes = new TextEncoder().encode("name\nx\n");
    expect((await readCsv(bytes, LIMITS)).records).toHaveLength(1);
    expect((await readCsv((function* chunks() {
      yield "na";
      yield "me\n\"split ";
      yield "cell\"\n";
    })(), LIMITS)).records).toEqual([{row: 1, cells: {name: "split cell"}}]);
    expect((await readCsv(new Blob([bytes]).stream(), LIMITS)).records).toHaveLength(1);
  });

  it("refuses what is not a file", async() => {
    expect((await refusal(readCsv({}, LIMITS))).code).toBe("CSV_UNSUPPORTED");
    expect((await refusal(readCsv(42, LIMITS))).code).toBe("CSV_UNSUPPORTED");
    expect((await refusal(readCsv([1, 2], LIMITS))).code).toBe("CSV_UNSUPPORTED");
  });

  it("refuses a missing, blank or repeated header", async() => {
    expect((await refusal(readCsv("", LIMITS))).code).toBe("CSV_HEADER");
    expect((await refusal(readCsv("name,,note\n", LIMITS))).code).toBe("CSV_HEADER");
    expect(await refusal(readCsv("name,name\n", LIMITS))).toMatchObject({code: "CSV_HEADER", column: "name"});
  });

  it("refuses a delimiter that would make content structure", async() => {
    for (const delimiter of ["\"", "\n", ";;", ""]) {
      expect((await refusal(readCsv("a\n", LIMITS, {delimiter}))).code).toBe("CSV_PARSE");
    }
  });

  it("stops at the row and byte limits", async() => {
    expect((await refusal(readCsv("n\n1\n2\n3\n", {maxRows: 2, maxBytes: 1024}))).code).toBe("CSV_TOO_MANY_ROWS");
    expect((await readCsv("n\n1\n2\n", {maxRows: 2, maxBytes: 1024})).records).toHaveLength(2);
    // Counted across chunks, so a stream cannot slip under it a piece at a time.
    const endless = (function* endless() {
      yield "n\n";
      for (;;) {
        yield "1234567890\n";
      }
    })();
    expect((await refusal(readCsv(endless, {maxRows: 1e9, maxBytes: 100}))).code).toBe("CSV_TOO_LARGE");
  });
});

describe("resolveCsvLimits", () => {
  it("is off unless the instance turns it on, and a definition can only opt out", () => {
    expect(resolveCsvLimits(undefined, {maxRows: 5})).toBeUndefined();
    expect(resolveCsvLimits(false, undefined)).toBeUndefined();
    expect(resolveCsvLimits(true, false)).toBeUndefined();
    expect(resolveCsvLimits(true, undefined)).toEqual(DEFAULT_CSV_LIMITS);
  });

  it("lets the definition override the instance's numbers", () => {
    expect(resolveCsvLimits({maxRows: 50}, undefined)).toEqual({...DEFAULT_CSV_LIMITS, maxRows: 50});
    expect(resolveCsvLimits({maxRows: 50, maxBytes: 10}, {maxBytes: 99})).toEqual({maxRows: 50, maxBytes: 99});
  });
});

describe("csvCellValue", () => {
  it("converts by the column's abstract type", () => {
    expect(csvCellValue(" 42 ", DataTypes.Int)).toBe(42);
    expect(csvCellValue("1.5", DataTypes.Float)).toBe(1.5);
    expect(csvCellValue("YES", DataTypes.Boolean)).toBe(true);
    expect(csvCellValue("2024-01-02T03:04:05Z", DataTypes.Date)).toEqual(new Date("2024-01-02T03:04:05Z"));
    expect(csvCellValue("[1,2]", DataTypes.JSON)).toEqual([1, 2]);
    expect(csvCellValue("12345678901234567890", DataTypes.BigInt)).toBe("12345678901234567890");
    expect(csvCellValue(null, DataTypes.Int)).toBeNull();
  });

  it("refuses a cell that is not its type, rather than guessing", () => {
    for (const [raw, type] of [["1.5", DataTypes.Int], ["", DataTypes.Float], ["maybe", DataTypes.Boolean], ["soon", DataTypes.Date], ["{", DataTypes.JSON]] as const) {
      expect(() => csvCellValue(raw, type)).toThrow(CsvUploadError);
    }
  });
});
