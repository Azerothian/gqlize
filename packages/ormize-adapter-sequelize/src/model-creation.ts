// Model creation, attribute type resolution, class/instance method installation,
// and raw SQL function compilation. Free functions over a structural host rather
// than methods, following the pattern `query-options.ts` established.

import {
  ModelAttributes,
  ModelCtor,
  Model,
  QueryTypes,
  type Sequelize,
} from "sequelize";
import logger from "@azerothian/utilize/utils/logger";
import { scopeParametersIn, bindScopeParameters } from "@azerothian/utilize/gate";
import { copyField, copyModelOptions } from "@azerothian/utilize/utils/copy-on-write";
import { definitionMethods } from "@azerothian/utilize/exposed-methods";
import type { ResolvedScope } from "@azerothian/utilize/gate";
import {
  authoredDataType,
  type DataTypeDescriptor,
  type HookMap,
  type NativeDataType,
  type RequestContext,
} from "@azerothian/utilize/types/index";
import type { SequelizeDefinition, SqlClassMethod } from "./types";
import type { SequelizeModelClass } from "./types/query";
import { reservedOperatorNames } from "./utils/where-ops";
import type { SequelizeAdapterOptions, AuthoredAttributes } from "./adapter-types";

const log = logger("gqlize::adapter::sequelize::");

/**
 * A model prototype viewed as the plain object it is at runtime. Sequelize types
 * it as `Model<any, any>`, which has no index signature — but installing
 * relationship accessors and definition instance methods onto it *by name* is
 * exactly what this adapter does.
 */
export function prototypeOf(model: { prototype: unknown }): Record<string, unknown> {
  return model.prototype as Record<string, unknown>;
}

/**
 * The statics of a model class, by name — the counterpart of {@link prototypeOf}.
 * A definition's `classMethods` are installed onto the class by name, which
 * `ModelCtor` (no index signature, and rightly so) cannot describe.
 */
export function staticsOf(model: SequelizeModelClass): Record<string, unknown> {
  return model as unknown as Record<string, unknown>;
}

/**
 * What the model-creation functions reach into. Structural, so
 * `SequelizeAdapter` satisfies it by having these members.
 */
export interface ModelCreationHost {
  readonly sequelize: Sequelize;
  readonly options: SequelizeAdapterOptions;
  startup: { drop: string; create: string };
  resolveAttributeTypes(attributes: AuthoredAttributes): ModelAttributes;
}

/**
 * Warn about columns whose name collides with a reserved where-operator:
 * `replaceWhereOperators` would silently reinterpret a filter on such a column
 * as the operator instead of an equality filter — a hard-to-diagnose footgun.
 */
export function warnReservedFieldNames(defName: string, define: SequelizeDefinition["define"]): void {
  for (const fieldName of Object.keys(define || {})) {
    if (reservedOperatorNames.has(fieldName)) {
      log.error(
        `Model "${defName}" field "${fieldName}" collides with a reserved where-operator; ` +
        `filters on this column may be misinterpreted. Consider renaming it.`,
      );
    }
  }
}

/** Collect a definition's raw create/drop DDL, replayed by `initialise` / `reset`. */
export function registerStartupQueries(host: ModelCreationHost, queries: SequelizeDefinition["queries"]): void {
  const startupQueries = queries || {};
  Object.keys(startupQueries).forEach((k) => {
    const q = startupQueries[k];
    if (q.drop) {
      host.startup.drop += `${typeof q.drop === "function" ? q.drop() : q.drop}\n`;
    }
    if (q.create) {
      host.startup.create += `${typeof q.create === "function" ? q.create() : q.create}\n`;
    }
  });
}

export async function installClassMethods(
  sequelize: Sequelize,
  defName: string,
  classMethods: {[name: string]: unknown},
  generateSQLFn: (sqlFunc: SqlClassMethod, scopeModel?: string) => Promise<unknown>,
): Promise<void> {
  const model = sequelize.models[defName] as SequelizeModelClass;
  const statics = staticsOf(model);
  await Promise.all(
    Object.keys(classMethods).map(async (classMethod) => {
      if (typeof classMethods[classMethod] === "function") {
        statics[classMethod] = classMethods[classMethod];
        return;
      }
      // Not a function, so it is a {@link SqlClassMethod} descriptor — a raw
      // query or a Postgres function call — compiled into a static here.
      // `Definition.classMethods` names only the function form, so the
      // descriptor form is narrowed at this one branch.
      statics[classMethod] = await generateSQLFn(classMethods[classMethod] as SqlClassMethod, defName);
    })
  );
}

export function installInstanceMethods(
  sequelize: Sequelize,
  defName: string,
  instanceMethods: {[name: string]: unknown},
): void {
  const proto = prototypeOf(sequelize.models[defName]);
  Object.keys(instanceMethods).forEach((instanceMethod) => {
    proto[instanceMethod] = instanceMethods[instanceMethod];
  });
}

/**
 * Define a Sequelize model from an ormize definition, installing class methods,
 * instance methods, DDL queries, and the `definition` / `Model` back-references
 * the rest of this adapter reads.
 */
export async function createModelImpl(
  host: ModelCreationHost,
  def: SequelizeDefinition,
  hooks: HookMap | undefined,
  generateSQLFn: (sqlFunc: SqlClassMethod, scopeModel?: string) => Promise<unknown>,
): Promise<SequelizeModelClass> {
  const { defaultAttr, defaultModel } = host.options;
  // `copyModelOptions` rather than a bare spread: the spread makes a new
  // options object but leaves `options.indexes` pointing at the caller's array
  // of the caller's objects, and sequelize writes on both — `_conformIndex`
  // defaults `type`/`parser` onto each entry (and for a unique index sets
  // `unique` and deletes `type`), then `nameIndex` stamps a `name` derived
  // from the table name, so a definition reused against a second table
  // carried the first one's index name.
  const newDef = Object.assign({}, def, {
    options: Object.assign({}, copyModelOptions(defaultModel), copyModelOptions(def.options), {
      hooks,
    }),
  });
  // `SequelizeDefinition` declares `tableName` at the top level as well as
  // under `options`, but only `options` reaches `sequelize.define` — so the
  // top-level one type-checked and was then ignored, and the table took the
  // default name. The nested one wins when both are given.
  if (newDef.options.tableName === undefined && def.tableName !== undefined) {
    newDef.options.tableName = def.tableName;
  }
  if(!newDef.name) {
    throw new Error("Unable to create model with no name");
  }
  const defName = newDef.name;
  warnReservedFieldNames(defName, newDef.define);
  // Sequelize accepts `{paranoid: true, timestamps: false}`, reports
  // `options.paranoid === true` for it, and then defines no `deletedAt` column
  // — deletes from such a model are hard, silently. Easy to reach by accident
  // now that `defaultModel` can turn paranoid on for every model at once.
  if (newDef.options?.paranoid && newDef.options?.timestamps === false) {
    // `console.warn`, not the package's `debug`-based logger: `debug` is
    // silent unless `DEBUG` is set, which would make a silently-hard delete an
    // invisible event — the exact thing this check exists to surface.
    // eslint-disable-next-line no-console
    console.warn(
      `Model "${defName}": options.paranoid is set but timestamps are off, so there is no deletedAt column — deletes will be permanent. Enable timestamps, or drop paranoid.`,
    );
  }
  host.sequelize.define(
    defName,
    host.resolveAttributeTypes(Object.assign({}, defaultAttr, newDef.define)),
    newDef.options
  );
  registerStartupQueries(host, newDef.queries);

  if (newDef.disablePrimaryKey) {
    host.sequelize.models[defName].removeAttribute("id");
  }
  (newDef.removeAttributes || []).forEach((attr) => {
    host.sequelize.models[defName].removeAttribute(attr);
  });
  // Both spellings, merged — the nested `options.*` one wins a name both
  // declare. Picking one bag or the other dropped every top-level method
  // from a definition that also had an `options.instanceMethods` (#72).
  const classMethodsBag = definitionMethods(newDef, "classMethods");
  const instanceMethodsBag = definitionMethods(newDef, "instanceMethods");
  if (Object.keys(classMethodsBag).length > 0) {
    await installClassMethods(host.sequelize, defName, classMethodsBag, generateSQLFn);
  }
  if (Object.keys(instanceMethodsBag).length > 0) {
    installInstanceMethods(host.sequelize, defName, instanceMethodsBag);
  }

  const model = host.sequelize.models[defName] as SequelizeModelClass;
  prototypeOf(model).Model = model;
  model.definition = newDef;

  return model;
}

/**
 * @param modelName the model rows are mapped onto, which is often absent.
 * @param scopeModel the model whose row-level scope this statement is bound
 *   to (§12) — the definition the class method was installed on, not the one
 *   results are mapped to. Those are usually the same and need not be: a
 *   statement mapped onto nothing at all is still a read of *some* model.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- the published signature returns a Promise; the body builds the closure synchronously, but dropping `async` narrows the return type and is a breaking change
export async function createSQLFunctionImpl(
  sequelize: Sequelize,
  query: string,
  modelName: string | undefined,
  args: string[],
  scopeModel?: string,
) {
  // Read once, at build: the parameter list is a property of the statement,
  // and re-parsing it per call would be work done on every request to learn
  // something that cannot have changed.
  const scopeParameters = scopeParametersIn(query, args);
  const label = scopeModel ? `${scopeModel}'s raw SQL` : "a raw SQL class method";
  return async (a: { [argName: string]: unknown }, context: RequestContext) => {
    // security check?
    const opts = {
      replacements: args.reduce(
        (o: { [argName: string]: unknown }, ar: string) => {
          o[ar] = a[ar] ? a[ar] : null;
          return o;
        },
        {}
      ),
      type: QueryTypes.SELECT,
    } as {
      model: ModelCtor<Model>;
      replacements: { [argName: string]: unknown };
      type: QueryTypes;
    };
    if (scopeParameters.length > 0) {
      // §12: the engine cannot rewrite a statement that is already text, so a
      // reserved parameter is the whole of its reach into one. The audit
      // guarantees the parameter is there; this puts the value in it.
      //
      // `scopeFor` arrives on the context from `resolveClassMethod`. A static
      // called straight off the model has none, and binds nulls — which the
      // documented `(:scopeOwnerId IS NULL OR …)` idiom reads as unconstrained.
      // That path is closed by its runtime twin, the instance-level
      // `beforeQuery`, not here: this layer cannot tell "no scope configured"
      // from "the engine was bypassed", and guessing either way is worse than
      // letting the layer that knows decide.
      const scopeOf = (context as { scopeFor?: (m: string, o: string) => Promise<ResolvedScope> } | undefined)?.scopeFor;
      const resolved = scopeModel && typeof scopeOf === "function"
        ? await scopeOf(scopeModel, "read")
        : undefined;
      const bound = bindScopeParameters(query, args, resolved, label);
      if (bound === false) {
        // Denied outright. An empty page is what a caller with no matching
        // rows already sees, and a read has nothing louder to say that would
        // not itself confirm the rows exist.
        return [];
      }
      // After the argument reduction, never before it: `args` is caller-supplied
      // and a request that named `scopeOwnerId` among them would otherwise be
      // choosing the value that decides what it may read.
      Object.assign(opts.replacements, bound);
    }
    if (modelName) {
      opts.model = sequelize.models[modelName];
    }
    return sequelize.query(query, opts);
  };
}

export async function generateSQLFunctionImpl(
  sequelize: Sequelize,
  sqlFunc: SqlClassMethod,
  scopeModel?: string,
) {
  // PostgreSQL supported only atm?
  const {
    type = "query",
    schema = "public",
    functionName,
    query,
    modelName,
    args = [],
  } = sqlFunc;
  let q = "";
  switch (type) {
    case "query":
      q = query ?? "";
      break;
    case "sqlfunction":
      if (query) {
        q = query;
      } else {
        q = `SELECT * FROM "${schema}"."${functionName}"(${args
          .map((s) => `:${s}`)
          .join(",")});`;
      }
  }
  return createSQLFunctionImpl(sequelize, q, modelName, args, scopeModel);
}

/**
 * Convert any authored abstract ormize type tokens in an attribute map to
 * native Sequelize types. Native types (e.g. `Sequelize.STRING`) and fields
 * without a token `type` pass through unchanged (backward compatible).
 */
export function resolveAttributeTypesImpl(
  toNativeType: (descriptor: DataTypeDescriptor) => NativeDataType,
  attributes: AuthoredAttributes,
): ModelAttributes {
  const out: AuthoredAttributes = {};
  for (const key of Object.keys(attributes)) {
    const attr = attributes[key];
    // Shorthand form: `field: DataTypes.String`, or the bare-constructor
    // spelling `field: String`. `authoredDataType` is the shared table, so the
    // set of spellings a definition may use is the same on every backend — the
    // constructor form used to be accepted by the valkey adapter and passed
    // through untouched here, where `sequelize.define` turned it into a
    // `String` wrapper object and failed later, in DDL generation.
    const shorthand = authoredDataType(attr);
    if (shorthand) {
      out[key] = toNativeType(shorthand);
    } else if (attr && typeof attr === "object") {
      // Object form: `field: { type: DataTypes.String, allowNull: false }`
      //
      // Always a copy, including the native-type branch that used to pass the
      // descriptor straight through. `sequelize.define` hands these to
      // `Model.init`, which rewrites `type`/`defaultValue`/`references.model`
      // in place and then hangs `Model` (a *circular* back-reference),
      // `fieldName`, `field` and `_modelAttribute` on every attribute. Passing
      // the caller's object through made their definition unserializable and
      // carried one build's state into the next.
      const { type } = attr as { type?: unknown };
      const copy = copyField(attr) as { type?: unknown };
      const authored = authoredDataType(type);
      if (authored) {
        copy.type = toNativeType(authored);
      }
      out[key] = copy;
    } else {
      out[key] = attr;
    }
  }
  // Every entry is now either untouched — already a Sequelize attribute — or
  // one whose token `type` has just been converted to a native one. The
  // compiler cannot see that: what came in were `DefinitionField`s, whose
  // `type` is `unknown` by design (see {@link AuthoredAttributes}).
  return out as ModelAttributes;
}
