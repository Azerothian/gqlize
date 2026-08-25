import { describe, it, expect } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import { ValkeyModel } from "../src/model";

// `ValkeyModel` builds its field map straight from the definition, so these
// need no server.
describe("ValkeyModel - field metadata", () => {
  it("carries authored args/resolve through to the field map", () => {
    const resolve = (source: { label: string }) => source.label;
    const args = { casing: { type: "Casing" } };
    const model = new ValkeyModel({
      name: "Doc",
      define: {
        id: { type: DataTypes.UUID, primaryKey: true },
        label: { type: DataTypes.String },
        body: { type: DataTypes.String, args, resolve },
      },
    });

    expect(model.fields.body.args).toEqual(args);
    expect(model.fields.body.resolve).toBe(resolve);
    // A field authoring neither keeps both absent, so the gqlize snapshot
    // fingerprint of every model that predates this stays byte-identical.
    expect(model.fields.label.args).toBeUndefined();
    expect(model.fields.label.resolve).toBeUndefined();
  });

  it("carries `description`, accepting the sequelize `comment` spelling", () => {
    const model = new ValkeyModel({
      name: "Doc",
      define: {
        id: { type: DataTypes.UUID, primaryKey: true },
        described: { type: DataTypes.String, description: "from description" },
        commented: { type: DataTypes.String, comment: "from comment" },
        // `description` is what `DefinitionField` documents, so it wins.
        both: { type: DataTypes.String, description: "wins", comment: "loses" },
        plain: { type: DataTypes.String },
      },
    });

    expect(model.fields.described.description).toEqual("from description");
    expect(model.fields.commented.description).toEqual("from comment");
    expect(model.fields.both.description).toEqual("wins");
    expect(model.fields.plain.description).toBeUndefined();
  });
});
