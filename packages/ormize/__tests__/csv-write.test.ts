// `writeCsv`, the read side of CSV: what it writes, and that the upload reader
// (`readCsv`) reads it back cell for cell.
import { describe, it, expect } from "@jest/globals";
import { csvCellText, writeCsv } from "../src/csv/write";
import { readCsv } from "../src/csv/read";
import { CsvUploadError } from "../src/csv/errors";
import { DEFAULT_CSV_LIMITS } from "../src/csv/limits";

describe("csvCellText", () => {
  it("writes values the way an upload reads them back", () => {
    expect(csvCellText(undefined)).toBe("");
    expect(csvCellText(null)).toBe("\\N");
    expect(csvCellText(true)).toBe("true");
    expect(csvCellText(12.5)).toBe("12.5");
    expect(csvCellText(BigInt("9007199254740993"))).toBe("9007199254740993");
    expect(csvCellText(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(csvCellText({ a: [1, "x"] })).toBe("{\"a\":[1,\"x\"]}");
  });
});

describe("writeCsv", () => {
  it("quotes what needs quoting and ends lines in CRLF", () => {
    expect(writeCsv(["a", "b"], [{ a: "x,y", b: "say \"hi\"" }, { a: " pad", b: "two\nlines" }])).toBe(
      "a,b\r\n\"x,y\",\"say \"\"hi\"\"\"\r\n\" pad\",\"two\nlines\"\r\n",
    );
  });

  it("writes only the header for no rows, and nothing without one", () => {
    expect(writeCsv(["a"], [])).toBe("a\r\n");
    expect(writeCsv(["a"], [], { header: false })).toBe("");
  });

  it("refuses a delimiter that cannot round-trip", () => {
    expect(() => writeCsv(["a"], [], { delimiter: "\"" })).toThrow(CsvUploadError);
    expect(() => writeCsv(["a"], [], { delimiter: ";;" })).toThrow(CsvUploadError);
  });

  it("reads back through the upload reader", async () => {
    const rows = [
      { id: "1", name: "a, \"b\"\nc", rank: null, note: undefined },
      { id: "2", name: "plain", rank: 3, note: "x" },
    ];
    for (const delimiter of [",", ";", "\t"]) {
      const text = writeCsv(["id", "name", "rank", "note"], rows, { delimiter });
      const { header, records } = await readCsv(text, DEFAULT_CSV_LIMITS, { delimiter });
      expect(header).toEqual(["id", "name", "rank", "note"]);
      // `\N` reads back as null; an undefined value is the empty cell, which an
      // upload leaves out.
      expect(records.map((r) => r.cells)).toEqual([
        { id: "1", name: "a, \"b\"\nc", rank: null },
        { id: "2", name: "plain", rank: "3", note: "x" },
      ]);
    }
  });
});
