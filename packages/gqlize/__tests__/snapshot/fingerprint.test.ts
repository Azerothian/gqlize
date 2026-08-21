import {GraphQLObjectType, GraphQLString} from "graphql";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect} from "@jest/globals";

import {compareFingerprints, fingerprintDefinitions} from "../../src/snapshot";

/**
 * The fingerprint is the artifact's staleness check. Two properties matter and
 * pull against each other:
 *
 *  - it must **flip** on anything that reshapes the schema, or a stale artifact
 *    serves a schema that disagrees with the database;
 *  - it must **not** flip on sqlite -> postgres, because building the artifact in
 *    CI against sqlite and loading it in production against postgres is the
 *    intended workflow.
 *
 * These instances are only `initialise()`d, never `sync()`ed: fingerprinting
 * reads model metadata, so no database connection is required — which is what
 * lets the postgres half of the dialect test run without a server.
 */

function baseDefs(): any[] {
  return [
    {
      name: "Parent",
      define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{
        type: "hasMany",
        model: "Child",
        name: "children",
        options: {as: "children", foreignKey: "parentId"},
      }],
    },
    {
      name: "Child",
      define: {
        name: {type: Sequelize.STRING, allowNull: true},
        state: {type: Sequelize.ENUM("open", "closed"), allowNull: true},
      },
      relationships: [{
        type: "belongsTo",
        model: "Parent",
        name: "parent",
        options: {foreignKey: "parentId"},
      }],
    },
  ];
}

async function orm(defs: any[] = baseDefs(), dialect: any = "sqlite") {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect, logging: false}) as any, "db");
  defs.forEach((def) => db.addDefinition(def));
  await db.initialise();
  return db;
}

/** apply `mutate` to a fresh copy of the fixture, then fingerprint it */
async function fpWith(mutate: (defs: any[]) => void, opts?: any) {
  const defs = baseDefs();
  mutate(defs);
  return fingerprintDefinitions(await orm(defs), opts);
}

function byName(defs: any[], name: string) {
  return defs.find((d) => d.name === name);
}

describe("fingerprintDefinitions", () => {
  it("is identical across sqlite and postgres", async() => {
    // The whole point: the CLI commonly builds against sqlite while production
    // runs postgres, and the dialect does not change the schema's shape.
    expect(fingerprintDefinitions(await orm(baseDefs(), "sqlite")))
      .toEqual(fingerprintDefinitions(await orm(baseDefs(), "postgres")));
  });

  it("is stable across two identical instances", async() => {
    expect(fingerprintDefinitions(await orm())).toEqual(fingerprintDefinitions(await orm()));
  });

  it("accepts a raw ormize instance or a GqlizeBinding", async() => {
    const {default: GqlizeBinding} = await import("../../src/manager");
    const db = await orm();
    expect(fingerprintDefinitions(new GqlizeBinding(db))).toEqual(fingerprintDefinitions(db));
  });

  describe("flips `models` on", () => {
    let base: any;
    beforeAll(async() => {
      base = fingerprintDefinitions(await orm());
    });

    const drifts = async(fp: any) => compareFingerprints(base, fp);

    it("a new field", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").define.extra = {type: Sequelize.STRING, allowNull: true};
      }))).toEqual(["models"]);
    });

    it("a field turning non-null", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").define.name.allowNull = false;
      }))).toEqual(["models"]);
    });

    it("a field changing type", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").define.name.type = Sequelize.INTEGER;
      }))).toEqual(["models"]);
    });

    it("an enum gaining a member", async() => {
      // SDL-invisible-adjacent: the enum's *name* is unchanged, so hashing the
      // GraphQL type name alone would miss this.
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").define.state.type = Sequelize.ENUM("open", "closed", "archived");
      }))).toEqual(["models"]);
    });

    it("a field comment", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").comments = {fields: {name: "the child's name"}};
      }))).toEqual(["models"]);
    });

    it("a new relationship", async() => {
      // `adapters` moves too: it is keyed by definition name, so a new model
      // shows up there as well as in `models`. Both say "rebuild".
      expect(await drifts(await fpWith((defs) => {
        defs.push({name: "Pet", define: {name: {type: Sequelize.STRING, allowNull: true}}});
        byName(defs, "Child").relationships.push({
          type: "hasMany", model: "Pet", name: "pets",
          options: {as: "pets", foreignKey: "childId"},
        });
      }))).toEqual(["adapters", "models"]);
    });

    it("a relationship rename", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Parent").relationships[0].options.as = "kids";
      }))).toEqual(["models"]);
    });

    it("a new class method", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").expose = {
          classMethods: {query: {getThing: {type: GraphQLString, args: {q: {type: GraphQLString}}}}},
        };
      }))).toEqual(["models"]);
    });

    it("a class method gaining an argument", async() => {
      const withMethod = (args: any) => (defs: any[]) => {
        byName(defs, "Child").expose = {
          classMethods: {query: {getThing: {type: GraphQLString, args}}},
        };
      };
      expect(compareFingerprints(
        await fpWith(withMethod({q: {type: GraphQLString}})),
        await fpWith(withMethod({q: {type: GraphQLString}, limit: {type: GraphQLString}})),
      )).toEqual(["models"]);
    });

    it("a field override", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").override = {
          name: {type: new GraphQLObjectType({name: "ChildName", fields: {raw: {type: GraphQLString}}})},
        };
      }))).toEqual(["models"]);
    });

    it("an ignored field", async() => {
      expect(await drifts(await fpWith((defs) => {
        byName(defs, "Child").ignoreFields = ["name"];
      }))).toEqual(["models"]);
    });
  });

  describe("optionsShape", () => {
    it("ignores `permission` entirely, predicate set included", async() => {
      // The projection covers only what reshapes the *serialized* artifact. A
      // loading process routinely builds permission per request — a different set
      // of predicates present at load says nothing about the artifact being
      // stale, and hashing it made every such load report drift.
      const db = await orm();
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: {permission: {model: () => true}}}),
        fingerprintDefinitions(db, {options: {permission: {model: () => true, field: () => true}}}),
      )).toEqual([]);
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: {permission: {model: () => true}}}),
        fingerprintDefinitions(db, {options: {}}),
      )).toEqual([]);
    });

    it("does not flip on a different predicate *body*", async() => {
      // The one drift the fingerprint structurally cannot see — closures are not
      // hashable. `permissionProfile` and `gqlize check --strict` cover it.
      const db = await orm();
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: {permission: {model: () => true}}}),
        fingerprintDefinitions(db, {options: {permission: {model: () => false}}}),
      )).toEqual([]);
    });

    it("flips on `subscriptions`, which does reshape the artifact", async() => {
      const db = await orm();
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: {}}),
        fingerprintDefinitions(db, {options: {subscriptions: true}}),
      )).toEqual(["optionsShape"]);
    });

    it("survives an independently constructed options object", async() => {
      // The build and the load never share an options object in practice: one is
      // written in a build script, the other in the server's bootstrap. Nothing
      // in the projection may depend on identity or on closures.
      const db = await orm();
      const buildOptions = {
        permission: {model: () => true, field: () => true},
        extend: {query: {health: {type: GraphQLString, resolve: () => "ok"}}},
      };
      const loadOptions = {
        permission: {relationship: (): boolean => false},
        root: {description: "Public API"},
      };
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: buildOptions}),
        fingerprintDefinitions(db, {options: loadOptions}),
      )).toEqual([]);
    });

    it("ignores `extend` and `root`, which are merged at load", async() => {
      const db = await orm();
      expect(compareFingerprints(
        fingerprintDefinitions(db, {options: {}}),
        fingerprintDefinitions(db, {options: {
          extend: {query: {health: {type: GraphQLString, resolve: () => "ok"}}},
          root: {description: "Public API"},
        }}),
      )).toEqual([]);
    });
  });

  describe("permissionProfile", () => {
    it("is reported on its own when only the profile differs", async() => {
      const db = await orm();
      expect(compareFingerprints(
        fingerprintDefinitions(db, {permissionProfile: "admin"}),
        fingerprintDefinitions(db, {permissionProfile: "anon"}),
      )).toEqual(["permissionProfile"]);
    });

    it("defaults to null rather than undefined, so it survives JSON", async() => {
      const fp = fingerprintDefinitions(await orm());
      expect(fp.permissionProfile).toBeNull();
      expect(JSON.parse(JSON.stringify(fp))).toEqual(fp);
    });
  });
});

describe("compareFingerprints", () => {
  it("returns nothing for equal fingerprints", async() => {
    const fp = fingerprintDefinitions(await orm());
    expect(compareFingerprints(fp, {...fp})).toEqual([]);
  });

  it("treats a missing fingerprint as drift, not as a match", () => {
    // "unchecked" must never read as "fresh" — that is the failure this exists for
    expect(compareFingerprints(undefined, {} as any)).toEqual(["fingerprint"]);
    expect(compareFingerprints({} as any, null)).toEqual(["fingerprint"]);
  });

  it("reports every differing key, sorted", async() => {
    const fp = fingerprintDefinitions(await orm());
    expect(compareFingerprints(fp, {...fp, models: "x", gqlizeVersion: "0.0.0"}))
      .toEqual(["gqlizeVersion", "models"]);
  });
});
