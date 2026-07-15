import Sequelize, {
  Model,
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
  countAll(args: any, context: any): Promise<number>;
}

const WidgetDef = defineModel<WidgetInstance, WidgetStatics>({
  name: "Widget",
  define: {
    name: { type: Sequelize.STRING, allowNull: false },
    qty: { type: Sequelize.INTEGER, allowNull: true },
  },
  classMethods: {
    async countAll(this: any) {
      return this.count();
    },
  },
});

describe("definition typesystem", () => {
  it("defineModel is a runtime identity (returns the definition verbatim)", () => {
    const raw = { name: "X", define: {} };
    expect(defineModel<WidgetInstance>(raw as any)).toBe(raw);
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
