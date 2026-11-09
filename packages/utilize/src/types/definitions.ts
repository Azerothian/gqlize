/**
 * Model definitions, fields, hooks, and exposed methods — the vocabulary a
 * definition author writes and the engine reads.
 */

import Events from "../events";
import type {
  RequestContext,
  FieldValue,
  FieldArgs,
  FieldArgsConfig,
  ExecutionInfo,
  LoadedRow,
  DefinitionHook,
  DefinitionMethod,
} from "./primitives";
import type {
  DeclaredIncludeMap,
  ExposedMethodContext,
  ExposedMethodOrderBy,
  ExposedMethodWhere,
} from "./selection";
import type { CsvLimits } from "./csv";

/**
 * A field's validation rules, keyed by validator name. The values are `unknown`
 * because each validator takes a different shape — a bare value (`min: 0`), a
 * flag (`isEmail: true`), a pair (`len: [1, 50]`), or the `{args, msg}` wrapper —
 * and it is the consumer that knows which form its own validators use.
 */
export type FieldValidators = {
  [validatorName: string]: unknown;
}

export type DefinitionFieldMeta = {
  name?: string;
  /** See {@link DefinitionField.type}. */
  type: unknown;
  foreignKey?: boolean;
  unique?: boolean;
  // Non-unique secondary index marker (see DefinitionField.index).
  index?: boolean;
  primaryKey?: boolean;
  ignoreGlobalKey?: boolean;
  description?: string;
  allowNull?: boolean;
  autoPopulated?: boolean;
  foreignTarget?: string;
  // Opt-in to allow a primary/foreign key to be set from client mutation input.
  // Defaults to false — see `isStructurallyWritable` (mass-assignment guard).
  writable?: boolean;
  resolve?: DefinitionHook;
  args?: FieldArgsConfig;
  comment?: string;
  /** See {@link DefinitionField.deprecated}. Carried through by the adapter. */
  deprecated?: string;
  defaultValue?: FieldValue;
}

export type DefinitionField = {
  /**
   * The field's type token, as authored: a `DataType` member, an adapter-native
   * type, or a GraphQL type. `unknown` rather than `any` because this package is
   * graphql-free and adapter-agnostic — it cannot name the union, and every
   * reader (adapter or gqlize builder) already dispatches on it at runtime.
   */
  type: unknown;
  foreignKey?: boolean;
  unique?: boolean;
  // Marks a field as a (non-unique) secondary index. Adapters that build their
  // own index structures (e.g. the Valkey adapter) use this — alongside `unique`
  // and foreign keys — to decide which fields are searchable.
  index?: boolean;
  primaryKey?: boolean;
  ignoreGlobalKey?: boolean;
  description?: string;
  allowNull?: boolean;
  autoPopulated?: boolean;
  /**
   * Opts a primary key or foreign key back into client-writable mutation input.
   * Both are excluded by default as a mass-assignment / IDOR guard — see
   * {@link isStructurallyWritable}. `false` keeps a foreign key guarded even
   * under `GqlizeOptions.writableForeignKeys`.
   */
  writable?: boolean;
  foreignTarget?: string;
  resolve?: DefinitionHook;
  args?: FieldArgsConfig;
  comment?: string;
  /**
   * Marks the generated field `@deprecated`, with this string as the reason.
   * The central {@link Definition.deprecations} map wins over this when both
   * name the same field, mirroring how `comments.fields` wins over
   * {@link DefinitionField.description}.
   */
  deprecated?: string;
  defaultValue?: FieldValue;
  values?: string[];
  validate?: FieldValidators;
}

export type DefinitionFields = {
  [name: string]: DefinitionField
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an operator is handed the partially built adapter-native `where`, the adapter's options bag and the client's raw filter value, and returns a backend-shaped fragment. Narrowing the parameters would reject the adapter implementations that legitimately declare their own concrete types for them.
export type WhereOperator = (whereObject: any, options: any, value: any) => Promise<any> | any
export type WhereOperators = {
  [name: string]: WhereOperator
}

/**
 * One entry under `expose.classMethods.{query,mutations}` or
 * `expose.instanceMethods.{query,mutations}`.
 *
 * Beyond the schema shape (`type`/`args`) and the pre/post hooks, an entry may
 * declare what the method *needs loaded* and how it *shapes the query*. Those
 * declarations exist because attribute narrowing projects a query down to the
 * columns the selection set asked for, and an exposed method is a field name,
 * not a column — so the columns it reads off `this` are dropped unless it says
 * which ones they are.
 */
export type ExposedMethod = {
  /**
   * See {@link DefinitionField.type}. Required for every target that produces an
   * output field; unused (and so optional) for `instanceMethods.mutations`,
   * which are pre-commit transforms rather than fields.
   */
  type?: unknown;
  args?: FieldArgsConfig;
  before?: DefinitionHook;
  after?: DefinitionHook;
  /**
   * Columns this method reads off `this`, unioned into the query's projection.
   * `"*"` opts the query out of attribute narrowing entirely.
   *
   * NOTE: these are server-side. `fields: ["passwordHash"]` loads a column the
   * client's own selection set could never reach — the definition author wrote
   * both sides, so that is their call.
   */
  fields?: string[] | "*";
  /** Relations this method reads, merged into (never clobbering) the include plan. */
  include?: DeclaredIncludeMap;
  /**
   * Shape the built query. Receives the same `params` object `definition.before`
   * receives, and runs *after* it — so a method's `input` sees the final options
   * and gets the last word on them. Return the params to use.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter's own options bag, handed in to be reshaped and returned — the same value `definition.before` receives (see {@link OptionHook}).
  input?: (params: any, ctx: ExposedMethodContext) => any;
  /**
   * Produce or format the field's value from the loaded row. Runs after the
   * method implementation (which receives `undefined` as `value` when there is
   * none — declaring `output` alone is how a field with no implementation
   * works) and before `after`.
   */
  output?: (value: FieldValue, ctx: ExposedMethodContext) => FieldValue;
  /** Contribute `<name>ASC` / `<name>DESC` to the model's `orderBy` enum. */
  orderBy?: ExposedMethodOrderBy;
  /** Contribute a normal nested operator object to the model's `where` input. */
  where?: ExposedMethodWhere;
  /**
   * Marks the field this method generates `@deprecated`, with this string as the
   * reason. Overridden by the matching entry in {@link Definition.deprecations}.
   * For `instanceMethods.mutations` — pre-commit transforms surfaced as fields of
   * the model's `apply` input rather than as query fields — it marks that input
   * field, which is where `comments.instanceMethods` puts the description too.
   */
  deprecated?: string;
};

/** A map of exposed methods, keyed by method name. */
export type ExposedMethods = {
  [name: string]: ExposedMethod;
};

export type Definition = {
  name?: string;
  datasource?: string;
  comment?: string;
  define?: DefinitionFields;
  override?: {
    [fieldName: string]: {
      description?: string
      /** See {@link DefinitionField.type}. */
      type?: unknown,
      /** See {@link DefinitionField.type}. */
      inputType?: unknown,
      input?: (o: FieldValue, args: FieldArgs, context: RequestContext, info: ExecutionInfo, model: LoadedRow) => FieldValue;
      output?: DefinitionHook
    }
  };
  /** Field names excluded from every generated type. */
  ignoreFields?: string[];
  /**
   * Deprecates the model as a whole: the root query list field and the root
   * mutation field for this model are both generated `@deprecated` with this
   * reason. GraphQL cannot deprecate an object type itself, so the mark lands
   * on the fields that lead to it.
   */
  deprecated?: string;
  /** Descriptions to attach to generated fields, keyed by the thing they describe. */
  comments?: DefinitionComments;
  /**
   * Deprecation reasons for generated fields, keyed exactly as
   * {@link Definition.comments} is. A reason here wins over the `deprecated`
   * written on the field or exposed method itself.
   */
  deprecations?: DefinitionDeprecations;
  relationships?: Relationship[];
  whereOperators?: WhereOperators;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each value is the GraphQL input type an operator's argument accepts; a graphql-free package cannot name `GraphQLInputType`, and the schema builder that reads this can.
  whereOperatorTypes?: { [x: string]: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter-native options bag the hook may reshape, and the return is whatever it hands back in its place — both are the backend's/author's vocabulary, not this package's.
  before?: (options: { params: any, model?: LoadedRow, args: FieldArgs, context: RequestContext, info: ExecutionInfo, modelDefinition: Definition, type: Events}) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `result` is whatever the operation produced — a row, a list of rows, a count — and the return is whatever the hook substitutes for it.
  after?: (options: { result: any, args: FieldArgs, context: RequestContext, info: ExecutionInfo, modelDefinition: Definition, type: Events}) => any;
  expose?: {
    classMethods?: {
      query?: ExposedMethods;
      mutations?: ExposedMethods;
    },
    instanceMethods?: {
      query?: ExposedMethods;
      /**
       * Pre-commit transforms, not a second mutation surface: each entry is a
       * custom function that reshapes the data on its way to the write, with the
       * row (update) or the pending values (create) as `this`. Surfaced as the
       * `apply` argument on the model's mutation field.
       */
      mutations?: ExposedMethods;
    }
  }
  instanceMethods?: {
    [name: string]: DefinitionMethod;
  }
  classMethods?: {
    [name: string]: DefinitionMethod;
  }
  hooks?: HookMap;
  /**
   * This model's part in the read cache ({@link GqlizeOptions.cache}). `false`
   * keeps every read of it out. An object overrides the cache-wide `ttl`, and
   * also opts in a model the cache would otherwise skip because it has its own
   * find/count hooks (see {@link CacheOptions.hooks}). This is an explicit
   * statement that those hooks give every caller the same result.
   */
  cache?: false | {ttl?: number};
  /**
   * This model's part in CSV mutation uploads ({@link GqlizeOptions.csv}).
   * `false` keeps the model out; an object overrides the instance-wide limits.
   * Has no effect while the instance has CSV off.
   */
  csv?: false | CsvLimits;
  options?: DefinitionOptions
};

export interface DefinitionOptions {
  /**
   * Whatever ormize does not name here is handed to the adapter's model
   * constructor verbatim — `timestamps`, `paranoid`, `tableName` and the rest of
   * the backend's own model options. There is no closed list because that set
   * belongs to the backend, not to ormize.
   */
  [option: string]: unknown;
  hooks?: HookMap;
  /**
   * When false, disables root-level eager resolution (auto-generated include tree)
   * for this model, falling back to per-relation resolution. Defaults to enabled.
   */
  autoInclude?: boolean;
  instanceMethods?: {
    [name: string]: DefinitionMethod;
  }
  classMethods?: {
    [name: string]: DefinitionMethod;
  }
}

/** See {@link Definition.comments}. */
export type DefinitionComments = {
  fields?: { [fieldName: string]: string };
  classMethods?: { [methodName: string]: string };
  /**
   * Deprecates the `apply` input field for each instance-method *transform* —
   * the same set `comments.instanceMethods` describes. An instance-method
   * *query* field deprecates through `fields`, since that is where its
   * description comes from too.
   */
  instanceMethods?: { [methodName: string]: string };
}

/**
 * See {@link Definition.deprecations}. Deliberately the same shape as
 * {@link DefinitionComments}: `fields` covers columns, overrides and
 * relationship names alike, because that is the one namespace generated output
 * fields share.
 */
export type DefinitionDeprecations = {
  fields?: { [fieldName: string]: string };
  classMethods?: { [methodName: string]: string };
  instanceMethods?: { [methodName: string]: string };
}

export type Definitions = {
  [name: string]: Definition
}

/**
 * An adapter's model handle — a Sequelize `ModelStatic`, a descriptor object,
 * whatever the backend registers. Indexed by name because adapters install
 * relationship accessors and definition methods onto it dynamically, which is
 * the whole reason it cannot be described more tightly here.
 */
export type Model = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapters install relationship accessors and definition methods onto the model handle at runtime, so its members are not knowable here (see the docblock above); `unknown` would make every `model.someAccessor(...)` in an adapter a compile error.
  [name: string]: any
  /**
   * Present on a class-based adapter's model (Sequelize's `ModelStatic`) and
   * absent on one whose model is a plain descriptor. Ormize tests for it before
   * installing a cross-adapter accessor and falls back to
   * {@link OrmAdapter.addInstanceFunction}, which is the whole reason that method
   * exists — so it has to be optional here or a descriptor-model adapter cannot
   * satisfy this contract at all.
   *
   * `object`, not a keyed record: Sequelize types its prototype as a `Model`,
   * which has no index signature, so a keyed record excludes the one adapter
   * that definitely has a prototype. The single place that installs a method by
   * name narrows it there instead — as the sequelize adapter's own `prototypeOf`
   * helper already does.
   */
  prototype?: object
}

export type HookMap = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each hook name has its own call signature — `beforeCreate(values, options)`, `afterFind(rows)` — fixed by the adapter that fires it, so a single parameter list would be wrong for most of them.
  [hookName: string]: ((...args: any) => any)[] |((...args: any) => any)
}

// Forward import — Relationship is defined in relationships.ts but needed here
// for Definition.relationships.
import type { Relationship } from "./relationships";
