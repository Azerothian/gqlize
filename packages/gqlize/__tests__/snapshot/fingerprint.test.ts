import {GraphQLObjectType, GraphQLScalarType, GraphQLString} from "graphql";
import Sequelize, {type Dialect} from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect} from "@jest/globals";

import {compareFingerprints, fingerprintDefinitions, type Fingerprint, type FingerprintOptions} from "../../src/snapshot";
import type {Definition} from "../../src/types";
import type GQLManager from "../../src/manager";
import {describeDrift, stableStringify} from "../../src/graphql/snapshot/fingerprint";

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

function baseDefs(): Definition[] {
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

async function orm(defs: Definition[] = baseDefs(), dialect: Dialect = "sqlite") {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect, logging: false}), "db");
  for (const def of defs) {
    await db.addDefinition(def);
  }
  await db.initialise();
  return db;
}

/** apply `mutate` to a fresh copy of the fixture, then fingerprint it */
async function fpWith(mutate: (defs: Definition[]) => void, opts?: FingerprintOptions) {
  const defs = baseDefs();
  mutate(defs);
  return fingerprintDefinitions(await orm(defs), opts);
}

function byName(defs: Definition[], name: string): Definition {
  const def = defs.find((d) => d.name === name);
  if (!def) {
    throw new Error(`Expected a definition named "${name}"`);
  }
  return def;
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
    let base!: Fingerprint;
    beforeAll(async() => {
      base = fingerprintDefinitions(await orm());
    });

    // `compareFingerprints` is synchronous, so `drifts` needs neither `async`
    // nor an `await` at its call sites.
    const drifts = (fp: Fingerprint) => compareFingerprints(base, fp);

    it("a new field", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").define!.extra = {type: Sequelize.STRING, allowNull: true};
      }))).toEqual(["models"]);
    });

    it("a field turning non-null", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").define!.name.allowNull = false;
      }))).toEqual(["models"]);
    });

    it("a field changing type", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").define!.name.type = Sequelize.INTEGER;
      }))).toEqual(["models"]);
    });

    it("an enum gaining a member", async() => {
      // SDL-invisible-adjacent: the enum's *name* is unchanged, so hashing the
      // GraphQL type name alone would miss this.
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").define!.state.type = Sequelize.ENUM("open", "closed", "archived");
      }))).toEqual(["models"]);
    });

    it("a field comment", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").comments = {fields: {name: "the child's name"}};
      }))).toEqual(["models"]);
    });

    it("a new relationship", async() => {
      // `adapters` moves too: it is keyed by definition name, so a new model
      // shows up there as well as in `models`. Both say "rebuild".
      expect(drifts(await fpWith((defs) => {
        defs.push({name: "Pet", define: {name: {type: Sequelize.STRING, allowNull: true}}});
        byName(defs, "Child").relationships!.push({
          type: "hasMany", model: "Pet", name: "pets",
          options: {as: "pets", foreignKey: "childId"},
        });
      }))).toEqual(["adapters", "models"]);
    });

    it("a relationship rename", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Parent").relationships![0].options.as = "kids";
      }))).toEqual(["models"]);
    });

    it("a new class method", async() => {
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").expose = {
          classMethods: {query: {getThing: {type: GraphQLString, args: {q: {type: GraphQLString}}}}},
        };
      }))).toEqual(["models"]);
    });

    it("a class method gaining an argument", async() => {
      const withMethod = (args: Record<string, {type: GraphQLScalarType}>) => (defs: Definition[]) => {
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
      expect(drifts(await fpWith((defs) => {
        byName(defs, "Child").override = {
          name: {type: new GraphQLObjectType({name: "ChildName", fields: {raw: {type: GraphQLString}}})},
        };
      }))).toEqual(["models"]);
    });

    it("an ignored field", async() => {
      expect(drifts(await fpWith((defs) => {
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
    // "unchecked" must never read as "fresh" — that is the failure this exists for.
    // The other side is `{}`: it is never read (both calls short-circuit on the
    // missing side), so it stands in for "any fingerprint-shaped value" rather
    // than a real one.
    expect(compareFingerprints(undefined, {} as unknown as Fingerprint)).toEqual(["fingerprint"]);
    expect(compareFingerprints({} as unknown as Fingerprint, null)).toEqual(["fingerprint"]);
  });

  it("reports every differing key, sorted", async() => {
    const fp = fingerprintDefinitions(await orm());
    expect(compareFingerprints(fp, {...fp, models: "x", gqlizeVersion: "0.0.0"}))
      .toEqual(["gqlizeVersion", "models"]);
  });
});

describe("the field-type fallback ladder", () => {
  /**
   * `fieldType` tries three projections in order — the GraphQL output type, then
   * ormize's abstract descriptor, then `String(nativeType)` — and only the first
   * one ever runs in a healthy build. The lower two exist for an adapter that
   * cannot answer, and they are load-bearing: the descriptor rung is what keeps
   * the fingerprint from flipping on sqlite -> postgres, and if the build ever
   * fell through to the `native:` rung it would flip on exactly that, silently.
   *
   * The rungs are module-private, so each is pinned by the `models` digest it
   * produces: three distinct digests is three distinct code paths, and the
   * dialect-stability assertion is what says *which* rung produced the middle one.
   */
  async function binding(patch: (instance: GQLManager) => void, dialect: Dialect = "sqlite") {
    const {default: GqlizeBinding} = await import("../../src/manager");
    const instance = new GqlizeBinding(await orm(baseDefs(), dialect));
    patch(instance);
    return fingerprintDefinitions(instance).models;
  }

  const blindToGraphQL = (instance: GQLManager) => {
    instance.getGraphQLOutputType = () => {
      throw new Error("no type mapper");
    };
  };

  it("falls back to the ormize descriptor when there is no GraphQL type", async() => {
    const native = fingerprintDefinitions(await orm()).models;
    expect(await binding(blindToGraphQL)).not.toEqual(native);
  });

  it("keeps the descriptor rung dialect-independent", async() => {
    // The reason this rung sits above `native:`: `String(nativeType)` is
    // "VARCHAR(255)" on one dialect and something else on the next, so falling
    // through to it would make a sqlite-built artifact look stale on postgres.
    expect(await binding(blindToGraphQL, "sqlite"))
      .toEqual(await binding(blindToGraphQL, "postgres"));
  });

  it("falls back to the native type when the adapter cannot classify it either", async() => {
    const descriptor = await binding(blindToGraphQL);
    const nativeRung = await binding((instance) => {
      blindToGraphQL(instance);
      const getModelAdapter = instance.getModelAdapter.bind(instance);
      instance.getModelAdapter = (defName: string) => {
        const adapter = getModelAdapter(defName);
        return adapter && Object.create(adapter, {
          mapDataType: {value: () => {
            throw new Error("unclassifiable");
          }},
        });
      };
    });
    expect(nativeRung).not.toEqual(descriptor);
  });
});

describe("stableStringify", () => {
  it("writes `undefined` as null rather than dropping it", () => {
    // `JSON.stringify(undefined)` is itself `undefined`, which would concatenate
    // into the digest as the literal text "undefined" — or, inside an array,
    // silently shift every later element. Both would make the hash unstable.
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify([1, undefined, 2])).toBe("[1,null,2]");
    expect(stableStringify(() => 1)).toBe("null");
  });

  it("sorts keys and omits undefined members", () => {
    expect(stableStringify({b: 1, a: 2, c: undefined})).toBe('{"a":2,"b":1}');
  });
});

describe("describeDrift", () => {
  const artifact: Fingerprint = {
    formatVersion: 1, gqlizeVersion: "7.0.0-beta.5", graphqlVersion: "17.0.2",
    adapters: "aaa", models: "bbb", permissionProfile: "public", idProfile: null, cursorProfile: null, optionsShape: "ccc",
  };

  it("prints the value for the keys where the value is the diagnosis", () => {
    const live = {...artifact, gqlizeVersion: "7.0.0-beta.6", permissionProfile: null};
    expect(describeDrift(["gqlizeVersion", "permissionProfile"], artifact, live)).toBe(
      'gqlizeVersion (artifact "7.0.0-beta.5", live "7.0.0-beta.6"), ' +
      'permissionProfile (artifact "public", live null)',
    );
  });

  it("names a digest key without printing it", () => {
    // Two sha256s side by side tell an operator nothing; the key alone says
    // "a model moved, rebuild", which is the whole actionable content.
    expect(describeDrift(["models", "adapters"], artifact, {...artifact, models: "x"}))
      .toBe("models, adapters");
  });

  it("degrades to bare keys when either side is missing", () => {
    expect(describeDrift(["gqlizeVersion"], artifact, null)).toBe("gqlizeVersion");
    expect(describeDrift(["gqlizeVersion"], undefined, artifact)).toBe("gqlizeVersion");
  });
});
