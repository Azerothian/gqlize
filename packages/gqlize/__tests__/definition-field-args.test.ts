import Sequelize from "sequelize";
import {
  graphql,
  printType,
  validateSchema,
  GraphQLEnumType,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLSchema,
} from "graphql";
import { describe, it, expect } from "@jest/globals";

import { createSchema } from "../src";
import { GQLIZE_EXT } from "../src/graphql/resolvers/types";
import type { GqlizeBuildLedger } from "../src/graphql/snapshot/ledger";
import { createInstance, validateResult } from "./helper";

// `define[field].args` / `define[field].resolve` are the authoring keys
// `createBasicFields` consumes: args become the built field's args, and a
// `resolve` gets a `modelField` binding instead of graphql's default property
// resolver. Both were dropped by every adapter (issue #20), so the whole path
// was unreachable from a real definition — these drive it end-to-end through
// `createSchema`.
const Casing = new GraphQLEnumType({
  name: "Casing",
  values: { UPPER: { value: "UPPER" }, LOWER: { value: "LOWER" } },
});

type DocRow = { title: string; body: string | null };

function docDefinition() {
  return {
    name: "Doc",
    define: {
      title: { type: Sequelize.STRING, allowNull: false },
      // `body` is a real column; `args`/`resolve` only change how it is read.
      body: {
        type: Sequelize.STRING,
        allowNull: true,
        args: { casing: { type: Casing } },
        resolve: (source: DocRow, args: { casing?: string }) => {
          const value = source.body;
          if (value === null || value === undefined) {
            return value;
          }
          return args.casing === "UPPER" ? value.toUpperCase() : value.toLowerCase();
        },
      },
    },
  };
}

function objectType(schema: GraphQLSchema, name: string) {
  return schema.getType(name) as GraphQLObjectType;
}

describe("definition field args/resolve", () => {
  it("puts authored args on the built field and binds the authored resolver", async() => {
    const instance = await createInstance([docDefinition()]);
    const schema = await createSchema(instance);
    expect(validateSchema(schema)).toEqual([]);

    const doc = objectType(schema, "Doc");
    const body = doc.getFields().body;
    expect(body.args.map((a) => a.name)).toEqual(["casing"]);
    expect(body.args[0].type).toBe(Casing);
    expect(typeof body.resolve).toEqual("function");
    // The SDL gains the argument.
    expect(printType(doc)).toContain("body(casing: Casing): String");

    // A field authoring neither is left alone: no args, and no binding — it
    // falls through to graphql's default property resolver.
    const title = doc.getFields().title;
    expect(title.args).toEqual([]);
    expect(title.resolve).toBeUndefined();
    expect(title.type.toString()).toEqual("String!");
  });

  it("runs the authored resolver, with the argument value, at query time", async() => {
    const instance = await createInstance([docDefinition()]);
    const schema = await createSchema(instance);
    await instance.models.Doc.create({ title: "t", body: "MiXeD" });

    const result = await graphql({
      schema,
      source: `query {
        models {
          Doc {
            edges { node { title upper: body(casing: UPPER) lower: body(casing: LOWER) } }
          }
        }
      }`,
    });
    validateResult(result);
    const data = result.data as unknown as {
      models: { Doc: { edges: { node: { title: string; upper: string; lower: string } }[] } };
    };
    const node = data.models.Doc.edges[0].node;
    expect(node.title).toEqual("t");
    expect(node.upper).toEqual("MIXED");
    expect(node.lower).toEqual("mixed");
  });

  it("records the arg's type in the build ledger so a snapshot can rehydrate it", async() => {
    // The arg types are whatever the author wrote — invisible to every other
    // recording site — so `createBasicFields` records them under a
    // `definitionField` ref keyed by def/field/arg.
    const instance = await createInstance([docDefinition()]);
    const schema = await createSchema(instance);

    const extensions = schema.extensions as Record<string, unknown>;
    const ledger = extensions[GQLIZE_EXT] as GqlizeBuildLedger;
    expect(ledger.externalTypes.Casing).toEqual({
      via: "definitionField",
      defName: "Doc",
      fieldName: "body",
      use: "arg",
      argName: "casing",
    });
  });

  it("leaves a scalar arg type alone", async() => {
    // Not every arg type is a custom enum; a built-in scalar must survive the
    // same path unchanged.
    const instance = await createInstance([{
      name: "Note",
      define: {
        text: {
          type: Sequelize.STRING,
          allowNull: true,
          args: { suffix: { type: GraphQLString } },
          resolve: (source: { text: string | null }, args: { suffix?: string }) =>
            `${source.text}${args.suffix || ""}`,
        },
      },
    }]);
    const schema = await createSchema(instance);
    expect(validateSchema(schema)).toEqual([]);
    const text = objectType(schema, "Note").getFields().text;
    expect(text.args[0].name).toEqual("suffix");
    expect(text.args[0].type).toBe(GraphQLString);
  });
});
