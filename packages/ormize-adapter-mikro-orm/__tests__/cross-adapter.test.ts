import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { MikroORM, EntitySchema } from "@mikro-orm/sqlite";
import { graphql, type GraphQLSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import MikroAdapter from "../src/index";

/**
 * A relationship whose two ends live on different backends.
 *
 * MikroORM cannot express one — the other end is not one of its entities — so
 * the mikro side declares it through the definition override, which merges with
 * what discovery found rather than replacing it. ormize resolves the hop itself,
 * through `createFunctionForFind`, `mergeFilterStatement` and
 * `andFilterStatements`; this suite is what proves those three are right.
 */

class Member {
  id!: number;
  name!: string;
  companyId?: number;
}

const MemberSchema = new EntitySchema<Member>({
  class: Member,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    // A plain column, not a MikroORM relation: the model it points at lives on
    // the other adapter, so there is no entity to reference.
    companyId: { type: "number", nullable: true },
  },
});

const companyDefinition = {
  name: "Company",
  define: { name: { type: DataTypes.String, allowNull: false } },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Member", name: "members", options: { foreignKey: "companyId" } },
  ],
};

describe("a relationship across two adapters", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the note in ormize.test.ts
  let db: any;
  let mikro: MikroORM;
  let schema: GraphQLSchema;

  beforeEach(async () => {
    mikro = await MikroORM.init({ entities: [MemberSchema], dbName: ":memory:", allowGlobalContext: true });
    db = new Ormize()
      .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sql")
      .registerAdapter(new MikroAdapter(mikro, {
        manageSchema: true,
        definitions: {
          Member: {
            relationships: [
              { type: "belongsTo", model: "Company", name: "company", options: { foreignKey: "companyId" } },
            ],
          },
        },
      }), "mikro");
    await db.addDefinition(companyDefinition, "sql");
    await db.initialise();
    await db.sync();
    schema = await createSchema(db);
  });
  afterEach(async () => { await mikro.close(true); });

  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({ schema, source, variableValues });
    if (result.errors) {
      throw result.errors[0];
    }
    return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  async function seed() {
    const acme = await db.models.Company.create({ name: "Acme" });
    const other = await db.models.Company.create({ name: "Globex" });
    await db.models.Member.create({ name: "Ada", companyId: acme.id });
    await db.models.Member.create({ name: "Grace", companyId: acme.id });
    await db.models.Member.create({ name: "Alan", companyId: other.id });
    return { acme, other };
  }

  it("routes each model to its own adapter", () => {
    // The names are the ones `registerAdapter` was given, which override the
    // adapters' own.
    expect(db.getModelAdapter("Company").adapterName).toBe("sql");
    expect(db.getModelAdapter("Member").adapterName).toBe("mikro");
  });

  it("keeps the relationships discovery found alongside the declared one", () => {
    const names = db.getDefinition("Member").relationships.map((r: { name: string }) => r.name);
    expect(names).toContain("company");
    // Member declares no MikroORM relations of its own, but the merge is by
    // name and additive — see `mergeRelationships`.
    expect(db.getAssociations("Member").company).toMatchObject({
      target: "Company", crossAdapter: true, foreignKey: "companyId",
    });
  });

  it("walks the hop from the SQL side", async () => {
    const { acme } = await seed();
    const page = await db.resolveManyRelationship("Member", db.getAssociations("Company").members, acme, {}, {});
    expect(page.total).toBe(2);
    expect(page.models.map((m: Member) => m.name).sort()).toEqual(["Ada", "Grace"]);
  });

  it("walks the hop from the MikroORM side", async () => {
    await seed();
    const [member] = await db.models.Member.findAll({ where: { name: "Alan" } });
    const company = await db.resolveSingleRelationship("Company", db.getAssociations("Member").company, member, {}, {});
    expect((company as { name: string }).name).toBe("Globex");
  });

  it("filters the far side on top of the join key", async () => {
    const { acme } = await seed();
    const page = await db.resolveManyRelationship("Member", db.getAssociations("Company").members, acme, {
      where: { name: { eq: "Ada" } },
    }, {});
    expect(page.total).toBe(1);
    expect(page.models[0].name).toBe("Ada");
  });

  it("serves both ends of the hop through one GraphQL query", async () => {
    await seed();
    const data = await run(`{
      models { Company(orderBy: [nameASC]) { edges { node {
        name
        members(orderBy: [nameASC]) { total edges { node { name company { name } } } }
      } } } }
    }`);
    const [acme, globex] = data.models.Company.edges.map((e: any) => e.node); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(acme.members.total).toBe(2);
    expect(acme.members.edges.map((e: any) => e.node.name)).toEqual(["Ada", "Grace"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(acme.members.edges[0].node.company.name).toBe("Acme");
    expect(globex.members.total).toBe(1);
  });

  it("runs a nested relationship mutation across the boundary", async () => {
    const { acme, other } = await seed();
    const [alan] = await db.models.Member.findAll({ where: { name: "Alan" } });
    await db.processRelationshipMutation("Company", acme, {
      members: { add: [{ id: { eq: alan.id } }] },
    }, {});
    expect((await db.resolveManyRelationship("Member", db.getAssociations("Company").members, acme, {}, {})).total).toBe(3);
    expect((await db.resolveManyRelationship("Member", db.getAssociations("Company").members, other, {}, {})).total).toBe(0);
  });
});
