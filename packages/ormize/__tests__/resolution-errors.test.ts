// Every name `Ormize` resolves at wiring time - adapter names, model names, and
// the models and key columns a relationship points at - used to be an unchecked
// map index, so a typo surfaced as `Cannot read properties of undefined` several
// frames below the mistake, as a raw driver error at the first query, or as
// nothing at all. See #14.
import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import { AnyTypedDef, Definition, Relationship } from "../src/types";
import { OrmAdapter } from "@azerothian/utilize/types/index";
import {describe, test, expect} from "@jest/globals";

const adapter = () => new SequelizeAdapter({}, {dialect: "sqlite"}) as OrmAdapter;

/** One manager with a single adapter registered as `sqlite`. */
const single = () => {
  const db = new Database();
  db.registerAdapter(adapter(), "sqlite");
  return db;
};

/** Two adapters, so a definition can be put on either side of an adapter boundary. */
const dual = () => {
  const db = single();
  db.registerAdapter(adapter(), "sqlite2");
  return db;
};

// `relationships` is Partial because half these cases are relationships missing
// the very key under test - a name, a type, a target model.
const def = (name: string, define: Definition["define"] = {}, relationships: Partial<Relationship>[] = []): Definition =>
  ({name, define, relationships: relationships as Relationship[]});

// A factory, not a shared literal: sequelize stamps `field`/`fieldName` onto the
// attribute object it is given, so reusing one instance aliases the columns.
const str = () => ({type: Sequelize.STRING, allowNull: true});

describe("adapter resolution", () => {
  test("def.datasource names an adapter that was never registered", async() => {
    const db = single();
    await expect(db.addDefinition({...def("Foo"), datasource: "postgres"}))
      .rejects.toThrow("Cannot add definition 'Foo': no adapter named 'postgres' is registered (from def.datasource). Registered adapters: 'sqlite'.");
  });

  test("the adapterName argument names an adapter that was never registered", async() => {
    const db = single();
    await expect(db.addDefinition(def("Foo"), "sqlite3"))
      .rejects.toThrow("no adapter named 'sqlite3' is registered (from the adapterName argument)");
  });

  test("no adapter is registered at all - the definition is not to blame", async() => {
    const db = new Database();
    await expect(db.addDefinition(def("Foo")))
      .rejects.toThrow("Cannot add definition 'Foo': no adapters are registered - call registerAdapter() before addDefinition().");
  });

  test("a fluent define() against an unknown adapter names the model it came from", async() => {
    const db = single();
    db.define(def("Foo") as AnyTypedDef, "nope");
    // The stack points at `initialise()`, never at the `define()` call, so the
    // message is the only thing that can carry the model name.
    await expect(db.initialise()).rejects.toThrow("Cannot add definition 'Foo': no adapter named 'nope' is registered");
  });

  test("a failed addDefinition leaves nothing behind, so a retry succeeds", async() => {
    const db = single();
    await expect(db.addDefinition({...def("Foo"), datasource: "postgres"})).rejects.toThrow();
    expect(db.defs.Foo).toBeUndefined();
    expect(db.defsAdapters.Foo).toBeUndefined();
    expect(db.models.Foo).toBeUndefined();
    await db.addDefinition(def("Foo"));
    expect(db.defs.Foo).toBeDefined();
  });

  test("an adapter with no name is rejected rather than keyed 'undefined'", () => {
    const db = new Database();
    expect(() => db.registerAdapter({} as OrmAdapter))
      .toThrow("Ormize.registerAdapter: adapter has no adapterName and no override name was given");
    expect(Object.keys(db.adapters)).toEqual([]);
    expect(db.defaultAdapter).toBeUndefined();
  });

  test("an override name satisfies an adapter that has none of its own", () => {
    const db = new Database();
    db.registerAdapter({} as OrmAdapter, "named");
    expect(db.defaultAdapter).toEqual("named");
  });
});

describe("model resolution", () => {
  test("an unknown model is reported as such, and lists the models that exist", async() => {
    const db = single();
    await db.addDefinition(def("Foo"));
    expect(() => db.getFields("Nope"))
      .toThrow("Ormize.getModelAdapter: no model named 'Nope' has been defined. Defined models: 'Foo'.");
  });

  test("a model whose adapter is missing is a different error from a missing model", async() => {
    const db = single();
    await db.addDefinition(def("Foo"));
    // Only reachable by unregistering behind the manager's back, but it is the
    // second of the two hops `getModelAdapter` makes and it needs its own voice.
    delete db.adapters.sqlite;
    expect(() => db.getFields("Foo"))
      .toThrow("no adapter named 'sqlite' is registered (model 'Foo' was defined against it)");
  });

  test("getModel and getDefinitionHooks report the model, not a TypeError", async() => {
    const db = single();
    expect(() => db.getModel("Nope")).toThrow("no model named 'Nope' has been defined");
    await expect(db.getDefinitionHooks("Nope"))
      .rejects.toThrow("Ormize.getDefinitionHooks: no model named 'Nope' has been defined");
  });

  test("hasDefinition answers the question without throwing", async() => {
    const db = single();
    expect(db.hasDefinition("Foo")).toEqual(false);
    await db.addDefinition(def("Foo"));
    expect(db.hasDefinition("Foo")).toEqual(true);
  });
});

describe("relationship validation", () => {
  const wire = async(db: Database, relationships: Partial<Relationship>[], targetDefine: Definition["define"] = {}) => {
    await db.addDefinition(def("Bar", targetDefine));
    await db.addDefinition(def("Foo", {}, relationships));
    return db.initialise();
  };

  test("a target model that was never defined", async() => {
    const db = single();
    await db.addDefinition(def("Foo", {}, [{name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "fooId"}}]));
    await expect(db.initialise())
      .rejects.toThrow("Relationship 'Foo.bars' (hasMany) targets model 'Bar', which has not been defined");
  });

  test("a target model that was never defined, and no foreignKey to blame instead", async() => {
    const db = single();
    await db.addDefinition(def("Foo", {}, [{name: "bars", type: "hasMany", model: "Bar", options: {}}]));
    // This used to report a missing foreign key - true of the input, but not the
    // reason it failed, and supplying one only moved the crash.
    await expect(db.initialise())
      .rejects.toThrow("targets model 'Bar', which has not been defined");
  });

  test("no target model at all", async() => {
    const db = single();
    await db.addDefinition(def("Foo", {}, [{name: "bars", type: "hasMany", options: {}}]));
    await expect(db.initialise()).rejects.toThrow("Relationship 'Foo.bars' (hasMany) does not name a target model.");
  });

  test("an unnamed relationship is rejected rather than stored under the key 'undefined'", async() => {
    const db = single();
    await expect(wire(db, [{type: "hasMany", model: "Bar", options: {foreignKey: "fooId"}}]))
      .rejects.toThrow("Relationship on 'Foo' targeting 'Bar' has no name.");
  });

  test("an unknown relationship type is rejected on the same-adapter branch", async() => {
    const db = single();
    // The manager's own guard used to sit below the same-adapter early return,
    // leaving this case to whichever adapter happened to validate.
    await expect(wire(db, [{name: "bars", type: "hasLots", model: "Bar", options: {foreignKey: "fooId"}}]))
      .rejects.toThrow("Relationship 'Foo.bars': unknown relationship type 'hasLots'. Expected one of 'belongsTo', 'hasOne', 'hasMany', 'belongsToMany'.");
  });

  test("an unknown relationship type is rejected on the cross-adapter branch", async() => {
    const db = dual();
    await db.addDefinition(def("Bar"), "sqlite2");
    await db.addDefinition(def("Foo", {}, [{name: "bars", type: "hasLots", model: "Bar", options: {foreignKey: "fooId"}}]), "sqlite");
    await expect(db.initialise()).rejects.toThrow("unknown relationship type 'hasLots'");
  });

  test("a same-adapter relationship may omit options entirely", async() => {
    const db = single();
    await expect(wire(db, [{name: "bars", type: "hasMany", model: "Bar"}])).resolves.not.toThrow();
  });

  test("a relationship is still wired when it is valid", async() => {
    const db = single();
    await wire(db, [{name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "fooId"}}]);
    expect(db.relationships.Foo.bars.internal).toEqual(true);
  });
});

describe("cross-adapter key validation", () => {
  test("a foreignKey naming no column on the target fails at initialise, not at the first query", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str()}, [
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "nopeId"}},
    ]), "sqlite");
    await expect(db.initialise()).rejects.toThrow(
      "Cross-adapter relationship 'Foo.bars' (hasMany) declares foreignKey 'nopeId', but model 'Bar' has no such field. "
      + "A cross-adapter key must be declared on the definition - ormize cannot create it.");
  });

  test("the message lists the fields the target does have", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str()}, [
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "nopeId"}},
    ]), "sqlite");
    await expect(db.initialise()).rejects.toThrow("Fields on 'Bar': 'id', 'a', 'createdAt', 'updatedAt'.");
  });

  test("a sourceKey naming no column on the source is caught too", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str(), fooId: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str()}, [
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "fooId", sourceKey: "nope"}},
    ]), "sqlite");
    await expect(db.initialise()).rejects.toThrow("declares sourceKey 'nope', but model 'Foo' has no such field");
  });

  test("a belongsTo targetKey naming no column on the target is caught", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str(), barId: str()}, [
      {name: "bar", type: "belongsTo", model: "Bar", options: {foreignKey: "barId", targetKey: "nope"}},
    ]), "sqlite");
    await expect(db.initialise()).rejects.toThrow("declares targetKey 'nope', but model 'Bar' has no such field");
  });

  test("declared keys wire cleanly", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str(), fooId: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str()}, [
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "fooId"}},
    ]), "sqlite");
    await db.initialise();
    await db.sync({force: true});
    const foo = await db.models.Foo.create({a: "x"});
    await db.models.Bar.create({a: "y", fooId: foo.id});
    const bars = await foo.getBars();
    expect(bars.length).toEqual(1);
  });

  test("a cross-adapter belongsToMany validates against its generated join model", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str()}, [
      {name: "bars", type: "belongsToMany", model: "Bar", options: {foreignKey: "fooId", otherKey: "barId"}},
    ]), "sqlite");
    // `generateJoinModels` creates BarFoo with both columns, so the pass over the
    // finished schema has to run after it - not while relationships are wiring.
    await expect(db.initialise()).resolves.not.toThrow();
    expect(db.hasDefinition("BarFoo")).toEqual(true);
  });

  test("a same-adapter relationship is not held to the same rule", async() => {
    const db = single();
    await db.addDefinition(def("Bar", {a: str()}));
    await db.addDefinition(def("Foo", {a: str()}, [
      // Sequelize creates `fooId` on Bar itself; only a cross-adapter key has
      // nobody to create it.
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "fooId"}},
    ]));
    await expect(db.initialise()).resolves.not.toThrow();
  });

  test("a key created by another model's relationship is not a false positive", async() => {
    const db = dual();
    await db.addDefinition(def("Bar", {a: str()}, [
      // Same-adapter belongsTo: sqlite2 creates `otherId` on Bar as a side effect,
      // concurrently with Foo's relationship being wired.
      {name: "other", type: "belongsTo", model: "Other", options: {foreignKey: "otherId"}},
    ]), "sqlite2");
    await db.addDefinition(def("Other", {a: str()}), "sqlite2");
    await db.addDefinition(def("Foo", {a: str(), otherId: str()}, [
      {name: "bars", type: "hasMany", model: "Bar", options: {foreignKey: "otherId"}},
    ]), "sqlite");
    await expect(db.initialise()).resolves.not.toThrow();
  });
});
