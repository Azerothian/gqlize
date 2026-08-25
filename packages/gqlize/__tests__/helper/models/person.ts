import Sequelize, {Op} from "sequelize";
import {GraphQLInt, GraphQLString} from "graphql";
import type {Definition, OrderEntry} from "../../../src/types/index";

/**
 * The declarative half of `expose.instanceMethods.query`, in one model.
 *
 * Lives outside the five shared models on purpose: `schema-golden.test.ts` pins
 * the SDL those produce, and this model exists to be *shaped* by whatever the
 * test at hand is exercising. `createInstance([Person, Pet])` adds it.
 *
 * `"firstName" || ' ' || "lastName"` rather than `concat(...)`: `||` is the
 * standard concatenation operator and both dialects under test speak it, and
 * both accept double-quoted identifiers, so the literal expressions below are
 * portable as written.
 */
const FULL_NAME = `("firstName" || ' ' || "lastName")`;

export const PetModel: Definition = {
  name: "Pet",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
    kind: {type: Sequelize.STRING, allowNull: true},
  },
  relationships: [{
    type: "belongsTo",
    model: "Person",
    name: "owner",
    options: {foreignKey: "personId"},
  }],
  expose: {
    instanceMethods: {
      query: {
        // A computed filter on the *include* side: `Person.pets(where: ...)`
        // must expand it the same way the root query does.
        label: {
          type: GraphQLString,
          fields: ["name", "kind"],
          output: (_value, {source}) => `${source.get("kind")}:${source.get("name")}`,
          where: {
            type: GraphQLString,
            operators: ["eq"],
            resolve: (_where, _options, value) => {
              const [kind, name] = String(value[Op.eq]).split(":");
              return {kind, name};
            },
          },
        },
      },
    },
  },
  options: {tableName: "pets"},
};

const PersonModel: Definition = {
  name: "Person",
  define: {
    firstName: {type: Sequelize.STRING, allowNull: false},
    lastName: {type: Sequelize.STRING, allowNull: false},
    secret: {type: Sequelize.STRING, allowNull: true},
  },
  relationships: [{
    type: "hasMany",
    model: "Pet",
    name: "pets",
    options: {foreignKey: "personId"},
  }],
  before(req) {
    // Ordering probe, inert unless a test supplies `context.trace` — it must not
    // perturb the queries every other test in this file runs.
    if (Array.isArray(req.context?.trace)) {
      req.context.trace.push("before");
    }
    return req.params;
  },
  expose: {
    instanceMethods: {
      query: {
        // No implementation at all — the value is produced by `output` from the
        // columns `fields` declared, and is sortable and filterable besides.
        fullName: {
          type: GraphQLString,
          fields: ["firstName", "lastName"],
          output: (_value, {source}) => `${source.get("firstName")} ${source.get("lastName")}`,
          orderBy: ["lastName", "firstName"],
          where: {
            type: GraphQLString,
            // `resolve` can only split an exact name, so only `eq` is offered:
            // generating `like` here would be a promise the backend cannot keep.
            operators: ["eq"],
            resolve: (_where, _options, value) => {
              const [first, ...rest] = String(value[Op.eq]).split(" ");
              return {firstName: first, lastName: rest.join(" ")};
            },
          },
        },
        // Has an implementation, and every post-hook: implementation -> output
        // -> after.
        greeting: {
          type: GraphQLString,
          fields: ["firstName"],
          output: (value) => String(value).toUpperCase(),
          after: (value: string) => `${value}!`,
        },
        // Reads a relation rather than a column.
        petNames: {
          type: GraphQLString,
          include: {pets: {}},
          output: (_value, {source}) =>
            (source.pets || []).map((p: {get(k: string): string}) => p.get("name")).sort().join(","),
        },
        // Opts the whole query out of attribute narrowing.
        everything: {
          type: GraphQLString,
          fields: "*",
        },
        // Shapes the built query. Runs after `definition.before`, so it gets the
        // last word on the options that hook wrote.
        limited: {
          type: GraphQLString,
          fields: ["firstName"],
          input: (params, ctx) => {
            if (Array.isArray(ctx.context?.trace)) {
              ctx.context.trace.push(`input:limited:${ctx.args?.only || ""}`);
            }
            if (ctx.args?.only) {
              // Overwrites whatever the client asked for — proving `input` runs
              // last and gets the final say on the options.
              params.where = {firstName: ctx.args.only};
            }
            return params;
          },
          args: {only: {type: GraphQLString}},
          output: (_value, ctx) => ctx.args?.only || "all",
        },
        // Portable filter form: borrow a real column's type and operators.
        surname: {
          type: GraphQLString,
          fields: ["lastName"],
          where: "lastName",
          output: (_value, {source}) => source.get("lastName"),
        },
        // Sorts by an expression no column name can spell.
        nameLength: {
          type: GraphQLInt,
          fields: ["firstName", "lastName"],
          orderBy: (direction) => [[Sequelize.literal(`LENGTH(${FULL_NAME})`), direction] as unknown as OrderEntry],
          output: (_value, {source}) =>
            `${source.get("firstName")} ${source.get("lastName")}`.length,
        },
        // Only ever reached with a permission that denies it.
        classified: {
          type: GraphQLString,
          fields: ["secret"],
          where: "secret",
          orderBy: ["secret"],
          output: (_value, {source}) => source.get("secret"),
        },
      },
      mutations: {
        // Direct-write flavour, on a model with no `before` interference.
        redact: {},
        // Args, and a returned value bag.
        rename: {
          args: {to: {type: GraphQLString}},
        },
        // Reads what an earlier transform in the same mutation wrote.
        stamp: {},
        boom: {},
        classifiedTransform: {},
      },
    },
  },
  options: {
    tableName: "people",
    instanceMethods: {
      greeting() {
        return `hi ${this.firstName}`;
      },
      everything() {
        return this.secret;
      },
      redact() {
        this.secret = null;
      },
      rename({to}: {to: string}) {
        return {firstName: to};
      },
      stamp() {
        return {secret: `stamped:${this.firstName}`};
      },
      boom() {
        throw new Error("transform exploded");
      },
      classifiedTransform() {
        return {secret: "should never run"};
      },
    },
  },
};

export default PersonModel;
