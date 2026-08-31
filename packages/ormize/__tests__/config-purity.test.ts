import { describe, it, expect, jest } from "@jest/globals";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { DataTypes, isOrmizeDataType } from "@azerothian/utilize/types/data-type";
import type { Definition } from "../src/types";
import Database, { type HookFunction } from "../src/manager";
import deepFreeze from "./helper/deep-freeze";

/**
 * Config purity: a `Definition`, and the options bag handed to `new Ormize`,
 * belong to the caller. Ormize reads them; it must never write to them.
 *
 * The bug this pins: definitions were handed straight to the backend, and
 * sequelize writes on whatever it is given — `Model` (a circular
 * back-reference), `fieldName`, `field` and `_modelAttribute` onto every
 * attribute, `name`/`type`/`parser` onto every index entry — while the adapter
 * itself overwrote `relationships[].options.through.model` from a model *name*
 * to a model *class*. A definition module imported once and built twice
 * therefore carried the first build's state into the second.
 */

/**
 * A structural fingerprint of a config tree.
 *
 * `JSON.stringify` cannot do this job alone: it drops functions silently, and
 * it *throws* on the circular `Model` back-reference that is one of the things
 * being tested for. So collapse every non-data value to a stable tag and
 * record the key *set* of every plain object — an added key shows up as a diff
 * even when its value would have fingerprinted to something bland.
 */
function fingerprint(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") {
    return `[fn ${value.name}]`;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (isOrmizeDataType(value)) {
    return `[ormize ${value.type}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return `[${(value).constructor?.name}]`;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => fingerprint(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = fingerprint((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

/**
 * A sequelize model class as this test drives it: constructible, and carrying
 * the relationship accessors sequelize generates once an association is wired.
 * `Model` types neither, for the reasons `manager.test.ts` documents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated accessor names exist only once sequelize wires the association; no static shape describes them
type ModelClass = { create(values: Record<string, unknown>): Promise<any> };

/** The model set used across most cases: one plain model plus a belongsToMany pair. */
function makeDefs(): Definition[] {
  return [
    {
      name: "Post",
      define: {
        // The native-Sequelize branch — the one that used to pass the caller's
        // descriptor straight through to `sequelize.define`.
        title: { type: Sequelize.STRING, allowNull: false },
        // The ormize-token branch, which was already copied.
        body: { type: DataTypes.String },
      },
      options: {
        tableName: "posts",
        indexes: [{ unique: true, fields: ["title"] }],
      },
      relationships: [
        {
          type: "belongsToMany", model: "Tag", name: "tags",
          options: { through: { model: "PostTag" }, foreignKey: "postId", otherKey: "tagId" },
        },
      ],
    },
    {
      name: "Tag",
      define: { label: { type: Sequelize.STRING } },
      options: { tableName: "tags" },
      relationships: [
        {
          type: "belongsToMany", model: "Post", name: "posts",
          options: { through: { model: "PostTag" }, foreignKey: "tagId", otherKey: "postId" },
        },
      ],
    },
    { name: "PostTag", define: { sortOrder: { type: Sequelize.INTEGER } }, options: { tableName: "post_tags" } },
  ];
}

async function build(defs: Definition[], options = {}) {
  const db = new Database(options);
  db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  for (const def of defs) {
    await db.addDefinition(def);
  }
  await db.initialise();
  await db.sync();
  return db;
}

describe("config purity — definitions", () => {
  it("leaves the whole definition tree structurally identical", async () => {
    const defs = makeDefs();
    const before = fingerprint(defs);
    await build(defs);
    expect(fingerprint(defs)).toEqual(before);
  });

  it("adds no sequelize internals to field descriptors", async () => {
    const defs = makeDefs();
    await build(defs);
    // The exact authored key set — no `Model`, `fieldName`, `field`, `_modelAttribute`.
    expect(Object.keys(defs[0].define!.title).sort()).toEqual(["allowNull", "type"]);
    expect(Object.keys(defs[0].define!.body).sort()).toEqual(["type"]);
  });

  it("leaves an authored type token as the token it was written as", async () => {
    const defs = makeDefs();
    await build(defs);
    // `Sequelize.STRING` is the class; `normalizeAttribute` used to replace it
    // in place with `new STRING()`.
    expect(defs[0].define!.title.type).toBe(Sequelize.STRING);
    expect(isOrmizeDataType(defs[0].define!.body.type)).toBe(true);
  });

  it("adds no sequelize internals to index entries", async () => {
    const defs = makeDefs();
    await build(defs);
    const index = (defs[0].options!.indexes as Record<string, unknown>[])[0];
    // `_conformIndex` defaults `type`/`parser` on; `nameIndex` stamps `name`.
    expect(Object.keys(index).sort()).toEqual(["fields", "unique"]);
    expect(index.name).toBeUndefined();
    expect(index.fields).toEqual(["title"]);
  });

  it("leaves relationships[].options.through.model a model name", async () => {
    const defs = makeDefs();
    await build(defs);
    // Collected, then asserted once: the adapter replaced the authored name with
    // a model *class*, so the interesting failure is a class here, not a miss.
    const through = defs
      .flatMap((def) => def.relationships || [])
      .map((rel) => rel.options?.through)
      .filter((t) => t && typeof t === "object")
      .map((t) => (t as {model?: unknown}).model);
    expect(through).toEqual(["PostTag", "PostTag"]);
  });

  it("leaves the definition serializable", async () => {
    const defs = makeDefs();
    await build(defs);
    // The circular `Model` back-reference made this throw.
    expect(() => JSON.stringify(defs)).not.toThrow();
  });

  it("builds the same definition module twice", async () => {
    const defs = makeDefs();
    await build(defs);
    // The headline case: a definition module imported once, built twice. This
    // failed on the second build, because the first had already rewritten
    // `through.model` into a model class the second could not resolve.
    const second = await build(defs);
    expect(second.getAssociations("Post").tags).not.toBeUndefined();

    // Wired, not merely present: exercise the join end to end on the second
    // build. Resolving `through` is what the pollution broke, and a
    // belongsToMany with an unresolved join cannot round-trip.
    const Post = second.models.Post as unknown as ModelClass;
    const Tag = second.models.Tag as unknown as ModelClass;
    const post = await Post.create({ title: "second build", body: "b" });
    const tag = await Tag.create({ label: "t" });
    await post.addTag(tag);
    expect((await post.getTags()).map((t: { label: string }) => t.label)).toEqual(["t"]);
  });

  it("survives a deep-frozen definition", async () => {
    // The strongest form of the assertion: in strict mode every polluting write
    // throws a TypeError naming the property it tried to add.
    const defs = deepFreeze(makeDefs());
    await expect(build(defs)).resolves.toBeDefined();
  });
});

describe("config purity — adapter options", () => {
  it("does not share defaultAttr descriptors between models", async () => {
    const defaultAttr = { tenantId: { type: Sequelize.INTEGER } };
    const db = new Database();
    db.registerAdapter(new SequelizeAdapter({ defaultAttr }, { dialect: "sqlite", logging: false }), "sqlite");
    await db.addDefinition({ name: "A", define: { a: { type: Sequelize.STRING } }, options: {} });
    await db.addDefinition({ name: "B", define: { b: { type: Sequelize.STRING } }, options: {} });
    await db.initialise();

    expect(Object.keys(defaultAttr.tenantId).sort()).toEqual(["type"]);
    expect(defaultAttr.tenantId.type).toBe(Sequelize.INTEGER);
    // Both models still got the column.
    expect(db.getModelAdapter("A").getFields("A").tenantId).not.toBeUndefined();
    expect(db.getModelAdapter("B").getFields("B").tenantId).not.toBeUndefined();
  });
});

describe("config purity — globalHooks", () => {
  it("does not append to the caller's hook array", () => {
    const authored = jest.fn() as unknown as HookFunction;
    const added = jest.fn() as unknown as HookFunction;
    const globalHooks = { beforeCreate: [authored] };
    const db = new Database({ globalHooks });

    db.addHook("beforeCreate", added);

    // `addHook` used to push straight into the caller's array, so two orms
    // built from one options bag shared a hook list.
    expect(globalHooks.beforeCreate).toHaveLength(1);
    expect(globalHooks.beforeCreate[0]).toBe(authored);
  });

  it("accepts a bare function, which HookMap permits", async () => {
    const authored = jest.fn((_defName: string, v: unknown) => v);
    const added = jest.fn((_defName: string, v: unknown) => v);
    // `.push` on a bare function threw `TypeError: push is not a function`.
    const db = new Database({ globalHooks: { beforeCreate: authored as unknown as HookFunction } });
    expect(() => db.addHook("beforeCreate", added as unknown as HookFunction)).not.toThrow();

    db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await db.addDefinition({ name: "Thing", define: { name: { type: Sequelize.STRING } }, options: {} });
    await db.initialise();
    await db.sync();
    await db.models.Thing.create({ name: "x" });

    // Both hooks run — the authored one was not dropped by the normalisation.
    expect(authored).toHaveBeenCalled();
    expect(added).toHaveBeenCalled();
  });
});

describe("config purity — declared include descriptors", () => {
  /**
   * The cross-request leak. A definition may declare an include whose `orderBy`
   * is a computed entry backed by a function of the request context. That
   * descriptor reaches the engine as the definition's *own* object, and the
   * order expansion used to write the expanded value back onto it — so the
   * first request's ordering was frozen into the definition and the function
   * never ran again.
   */
  async function buildOrderable() {
    const orderBy = jest.fn(
      (direction: unknown, ctx: { context?: { column?: string } }) =>
        [[ctx.context?.column ?? "label", direction]],
    );
    const defs: Definition[] = [
      {
        name: "Task",
        define: { name: { type: Sequelize.STRING } },
        options: { tableName: "tasks" },
        relationships: [{ type: "hasMany", model: "Item", name: "items", options: { foreignKey: "taskId" } }],
      },
      {
        name: "Item",
        define: { label: { type: Sequelize.STRING }, rank: { type: Sequelize.STRING } },
        options: { tableName: "items" },
        relationships: [{ type: "belongsTo", model: "Task", name: "task", options: { foreignKey: "taskId" } }],
        expose: {
          instanceMethods: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the declared `orderBy` shape is the exposed-method contract, not this test's to restate
            query: { byComputed: { orderBy } } as any,
          },
        },
      },
    ];
    const db = await build(defs);
    // The descriptor the definition owns, reached the way the merge path
    // reaches it — by identity.
    const descriptor = { target: "Item", associationType: "hasMany", orderBy: [["byComputed", "ASC"]] };
    return { db, descriptor, orderBy, defs };
  }

  it("does not rewrite a declared descriptor's orderBy", async () => {
    const { db, descriptor } = await buildOrderable();
    const before = JSON.parse(JSON.stringify(descriptor));

    await db.resolveFindAll("Task", undefined, { include: [{ items: descriptor }] }, {});

    // The declaration still names the computed entry, not its expansion.
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(before);
    expect(descriptor.orderBy).toEqual([["byComputed", "ASC"]]);
  });

  it("re-runs a context-dependent orderBy on every request", async () => {
    const { db, descriptor, orderBy } = await buildOrderable();

    await db.resolveFindAll("Task", undefined, { include: [{ items: descriptor }] }, { column: "label" });
    await db.resolveFindAll("Task", undefined, { include: [{ items: descriptor }] }, { column: "rank" });

    // Once per request, and the second saw its own context — the frozen
    // declaration used to make the second call expand nothing at all.
    expect(orderBy).toHaveBeenCalledTimes(2);
    expect(orderBy.mock.results[0].value).toEqual([["label", "ASC"]]);
    expect(orderBy.mock.results[1].value).toEqual([["rank", "ASC"]]);
  });
});
