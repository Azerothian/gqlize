import { describe, it, expect } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import { serialize, deserialize } from "../src/serialize";

// The field descriptors drive every branch of encode/decode; a field with no
// descriptor is meant to pass through untouched.
const fields = {
  id: {type: DataTypes.String},
  createdAt: {type: DataTypes.Date},
  views: {type: DataTypes.BigInt},
  price: {type: DataTypes.Decimal},
  rank: {type: DataTypes.Int},
  ratio: {type: DataTypes.Float},
  payload: {type: DataTypes.Blob},
  untyped: {},
};

describe("valkey serialize", () => {
  it("round-trips the types JSON cannot represent natively", () => {
    const createdAt = new Date("2020-01-02T03:04:05.000Z");
    const payload = Buffer.from("hello");
    const row = deserialize(fields, serialize(fields, {
      id: "a", createdAt, views: 9007199254740993n, price: "1.25",
      rank: 7, ratio: 0.5, payload, untyped: {nested: true},
    }));

    expect(row.createdAt).toEqual(createdAt);
    expect(row.views).toBe(9007199254740993n);   // past MAX_SAFE_INTEGER
    expect(row.price).toBe("1.25");              // stays a string for precision
    expect(row.rank).toBe(7);
    expect(row.ratio).toBe(0.5);
    expect(row.payload).toEqual(payload);
    expect(row.untyped).toEqual({nested: true});
  });

  it("returns null for a missing key, and a non-null row for a known string", () => {
    expect(deserialize(fields, null)).toBeNull();
    // The string overload: no `| null` to narrow away at the call site.
    const row: {[k: string]: unknown} = deserialize(fields, serialize(fields, {id: "a"}));
    expect(row.id).toBe("a");
  });

  it("lets a caller name the stored shape instead of returning `any`", () => {
    // The published contract this pins: `deserialize` used to return `any`, which
    // put an unchecked value into every call site. A caller that knows what it
    // stored names it and gets it back typed, with no cast — and a caller that
    // names nothing still compiles, it just has to narrow.
    type Doc = {id: string; rank: number};
    const doc = deserialize<Doc>(fields, serialize(fields, {id: "a", rank: 7}));
    const id: string = doc.id;
    const rank: number = doc.rank;
    expect([id, rank]).toEqual(["a", 7]);
  });
});
