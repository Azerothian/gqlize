import { describe, it, expect } from "@jest/globals";
import { DataTypes } from "sequelize";
import SequelizeAdapter from "../src/index";
import { DataType, isOrmizeDataType, DataTypes as OrmizeDataTypes } from "@azerothian/utilize/types/data-type";

function makeAdapter() {
  return new SequelizeAdapter({}, { dialect: "sqlite" });
}

describe("sequelize adapter - mapDataType (native -> abstract)", () => {
  const adapter = makeAdapter();

  it("maps scalar Sequelize DataTypes to abstract DataType", () => {
    expect(adapter.mapDataType(DataTypes.STRING).type).toBe(DataType.String);
    expect(adapter.mapDataType(DataTypes.TEXT).type).toBe(DataType.String);
    expect(adapter.mapDataType(DataTypes.INTEGER).type).toBe(DataType.Int);
    expect(adapter.mapDataType(DataTypes.FLOAT).type).toBe(DataType.Float);
    expect(adapter.mapDataType(DataTypes.BOOLEAN).type).toBe(DataType.Boolean);
    expect(adapter.mapDataType(DataTypes.BIGINT).type).toBe(DataType.BigInt);
    expect(adapter.mapDataType(DataTypes.DECIMAL).type).toBe(DataType.Decimal);
    expect(adapter.mapDataType(DataTypes.DATE).type).toBe(DataType.Date);
    expect(adapter.mapDataType(DataTypes.DATEONLY).type).toBe(DataType.DateOnly);
    expect(adapter.mapDataType(DataTypes.UUID).type).toBe(DataType.UUID);
    expect(adapter.mapDataType(DataTypes.JSON).type).toBe(DataType.JSON);
    expect(adapter.mapDataType(DataTypes.BLOB).type).toBe(DataType.Blob);
  });

  it("carries enum values", () => {
    const d = adapter.mapDataType(DataTypes.ENUM("a", "b"));
    expect(d.type).toBe(DataType.Enum);
    expect(d.values).toEqual(["a", "b"]);
  });

  it("recurses array element type", () => {
    const d = adapter.mapDataType(DataTypes.ARRAY(DataTypes.STRING));
    expect(d.type).toBe(DataType.Array);
    expect(d.element?.type).toBe(DataType.String);
  });

  it("classifies unknown/unsupported types as Unknown", () => {
    expect(adapter.mapDataType({ key: "SOMETHING_WEIRD" }).type).toBe(DataType.Unknown);
    expect(adapter.mapDataType(undefined).type).toBe(DataType.Unknown);
  });
});

describe("sequelize adapter - toNativeType (abstract -> native) + isOrmizeDataType", () => {
  const adapter = makeAdapter();

  it("round-trips abstract token -> native -> abstract", () => {
    const cases = [
      OrmizeDataTypes.String,
      OrmizeDataTypes.Int,
      OrmizeDataTypes.Float,
      OrmizeDataTypes.Boolean,
      OrmizeDataTypes.UUID,
      OrmizeDataTypes.Date,
      OrmizeDataTypes.Enum("x", "y"),
      OrmizeDataTypes.Array(OrmizeDataTypes.Int),
    ];
    for (const token of cases) {
      const native = adapter.toNativeType(token);
      const back = adapter.mapDataType(native);
      expect(back.type).toBe(token.type);
    }
  });

  it("isOrmizeDataType distinguishes tokens from native types", () => {
    expect(isOrmizeDataType(OrmizeDataTypes.String)).toBe(true);
    expect(isOrmizeDataType(OrmizeDataTypes.Enum("a"))).toBe(true);
    expect(isOrmizeDataType(DataTypes.STRING)).toBe(false);
    expect(isOrmizeDataType("STRING")).toBe(false);
    expect(isOrmizeDataType(undefined)).toBe(false);
  });
});
