import Sequelize, {
  Model,
  ModelStatic,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "../src";
import { defineModel } from "../src/types/orm";
import { describe, expect, it } from "@jest/globals";

// Author-declared instance interface, Sequelize v6 idiom.
interface WidgetInstance
  extends Model<InferAttributes<WidgetInstance>, InferCreationAttributes<WidgetInstance>> {
  id: CreationOptional<number>;
  name: string;
  qty: number | null;
}
interface WidgetStatics {
  countAll(args: unknown, context: unknown): Promise<number>;
}

const WidgetDef = defineModel<WidgetInstance, WidgetStatics>({
  name: "Widget",
  define: {
    name: { type: Sequelize.STRING, allowNull: false },
    qty: { type: Sequelize.INTEGER, allowNull: true },
  },
  classMethods: {
    // Not `async`: `this.count()` already returns the `Promise<number>` this
    // must produce, so there is nothing to await.
    countAll(this: ModelStatic<WidgetInstance>) {
      return this.count();
    },
  },
});

describe("definition typesystem", () => {
  it("defineModel is a runtime identity (returns the definition verbatim)", () => {
    const raw = { name: "X", define: {} };
    expect(defineModel<WidgetInstance>(raw)).toBe(raw);
    expect(WidgetDef.name).toEqual("Widget");
  });

  it("fluent define() chains, defers creation to initialise(), and builds a working model", async () => {
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });

    // Fluent chain: registerAdapter fixes the base URI, define() accumulates models.
    const db = new Ormize().registerAdapter(adapter).define(WidgetDef);

    // Model not created until initialise().
    expect(db.models.Widget).toBeUndefined();

    await db.initialise();
    await db.sync();

    expect(db.models.Widget).toBeDefined();

    const created = await db.models.Widget.create({ name: "alpha", qty: 3 });
    expect(created.name).toEqual("alpha");
    expect(created.qty).toEqual(3);

    await db.models.Widget.create({ name: "beta", qty: null });

    // static classMethod attached to the model
    const total = await db.models.Widget.countAll(undefined, {});
    expect(total).toEqual(2);

    const found = await db.models.Widget.findOne({ where: { name: "alpha" } });
    expect(found && found.name).toEqual("alpha");
  });
});

describe("getFields - authored field metadata", () => {
  // `args`/`resolve` are authored on a field for gqlize's benefit and mean
  // nothing to Sequelize. `getFields` reads them back off `rawAttributes`,
  // which relies on Sequelize carrying unknown attribute keys through `define`
  // untouched — undocumented behaviour, so this is the canary on it. If it ever
  // regresses, `createModel` also stashes the authored definition on the model
  // (`model.definition`), which `getFields` could read instead.
  it("passes authored args/resolve through rawAttributes", async () => {
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
    const resolve = (source: { name: string }) => source.name;
    const args = { casing: { type: "Casing" } };
    const db = new Ormize().registerAdapter(adapter).define({
      name: "Doc",
      define: {
        name: { type: Sequelize.STRING, allowNull: false },
        body: { type: Sequelize.STRING, allowNull: true, args, resolve },
      },
    });
    await db.initialise();

    const fields = adapter.getFields("Doc");
    expect(fields.body.args).toEqual(args);
    expect(fields.body.resolve).toBe(resolve);
    // A field authoring neither keeps both absent, so the snapshot fingerprint
    // of every model that predates this stays byte-identical.
    expect(fields.name.args).toBeUndefined();
    expect(fields.name.resolve).toBeUndefined();
  });

  it("accepts either spelling of the field description", async () => {
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
    const db = new Ormize().registerAdapter(adapter).define({
      name: "Described",
      define: {
        described: { type: Sequelize.STRING, description: "from description" },
        commented: { type: Sequelize.STRING, comment: "from comment" },
        // `description` is what `DefinitionField` documents, so it wins.
        both: { type: Sequelize.STRING, description: "wins", comment: "loses" },
        plain: { type: Sequelize.STRING },
      },
    });
    await db.initialise();

    const fields = adapter.getFields("Described");
    expect(fields.described.description).toEqual("from description");
    expect(fields.commented.description).toEqual("from comment");
    expect(fields.both.description).toEqual("wins");
    expect(fields.plain.description).toBeUndefined();
  });

  it("does not leak Sequelize's own attribute internals", async () => {
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
    const db = new Ormize().registerAdapter(adapter).define({
      name: "Plain",
      define: { name: { type: Sequelize.STRING, allowNull: false } },
    });
    await db.initialise();

    // Explicit keys, not a spread of `rawAttributes`: a spread would retain a
    // circular `Model` back-reference on every field of a memoised map.
    const field = adapter.getFields("Plain").name as Record<string, unknown>;
    expect(field.Model).toBeUndefined();
    expect(field._modelAttribute).toBeUndefined();
    expect(field.fieldName).toBeUndefined();
  });
});
