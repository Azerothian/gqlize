// Types owned by this adapter that multiple modules need but no single module
// is the natural home for. Kept separate from the class to avoid circular
// imports — every extraction module can import these without pulling in the
// adapter barrel.

import type {
  ModelAttributeColumnOptions,
  ModelAttributes,
  ModelOptions,
  Association as NativeAssociation,
  Options as SequelizeOptions,
} from "sequelize";
import type { DefinitionFieldMeta } from "@azerothian/utilize/types/index";

/**
 * A column as ormize authors one: Sequelize's own attribute options plus the two
 * flags this project adds. Declared here rather than as a module augmentation
 * because they are read by this adapter, never by Sequelize.
 */
export type OrmizeColumnOptions = ModelAttributeColumnOptions & {
  /** Keeps the column out of relay global-id translation — see `getGlobalKeys`. */
  ignoreGlobalKey?: boolean;
  /** Opts a primary/foreign key back into client-writable mutation input. */
  writable?: boolean;
  /**
   * GraphQL args for the field and a resolver hung off it by the author. Typed
   * off the shared meta rather than restated, so the two cannot drift.
   */
  args?: DefinitionFieldMeta["args"];
  resolve?: DefinitionFieldMeta["resolve"];
  /** The GraphQL field description; `comment` is the Sequelize-native spelling. */
  description?: string;
  /** The `@deprecated` reason for the generated field. Meaningless to Sequelize. */
  deprecated?: string;
};

/**
 * A live Sequelize association plus the three members its public typings omit.
 * `accessors` exists on every association at runtime (it is how Sequelize names
 * the generated `getTasks`/`countTasks` methods). `sourceKey`/`targetKey` exist
 * only on the association kinds that have one — a `hasMany` has a source key, a
 * `belongsTo` a target key — which is why both are optional here and defaulted
 * where they are read.
 */
export type NativeAssociationInternals = NativeAssociation & {
  accessors: import("@azerothian/utilize/types/index").Association["accessors"];
  sourceKey?: string;
  targetKey?: string;
  /** The resolved column name behind `identifier`, when they differ. */
  identifierField?: string;
  /** `belongsToMany` only: the join model and the join column pointing at the target. */
  through?: { model?: { name: string } };
  otherKey?: string;
};

/**
 * This adapter's own options — the first constructor argument. Closed, so a
 * misspelled key is a compile error rather than a setting that silently does
 * nothing; everything Sequelize itself understands belongs in the *second*
 * argument.
 */
export type SequelizeAdapterOptions = {
  /**
   * Attributes merged *under* every definition's own `define` map, so a
   * definition that declares the same column name wins. A shared audit column
   * (`tenantId`) belongs here rather than being repeated on every model.
   */
  defaultAttr?: ModelAttributes;
  /**
   * Model options merged *under* every definition's own `options`, so a
   * definition's own value wins and one can opt out of the default outright.
   * The merge order is what makes "all or some" expressible with one setting:
   *
   * ```ts
   * new SequelizeAdapter({defaultModel: {timestamps: true, paranoid: true}}, {dialect: "sqlite"})
   * // every model soft deletes…
   * db.addDefinition({name: "AuditLog", define: {…}, options: {paranoid: false}});
   * // …except this one.
   * ```
   *
   * Per-adapter, so a multi-adapter setup sets it on each Sequelize adapter it
   * registers. Note that `paranoid` needs `timestamps` — see the warning
   * `createModel` emits when the two disagree.
   */
  defaultModel?: ModelOptions;
  /** Skip the window-function row count even on a dialect that supports it. */
  disableInlineCount?: boolean;
  /** Opt in to the regex where-operators — see the ReDoS note in `createQueryConfig`. */
  enableRegexpOperators?: boolean;
};

/**
 * The argument list forwarded verbatim to Sequelize's own constructor. Sequelize
 * declares it as a set of positional overloads, and a spread argument cannot be
 * resolved against overloads — so the accepted shapes are named here, where a
 * caller's arguments are still checked against them.
 */
export type SequelizeConnection =
  | []
  | [options: SequelizeOptions]
  | [uri: string, options?: SequelizeOptions]
  | [database: string, username: string, options?: SequelizeOptions]
  | [database: string, username: string, password?: string, options?: SequelizeOptions];

/**
 * An attribute map as it arrives at `resolveAttributeTypes`: either Sequelize's
 * own {@link ModelAttributes} or a definition's fields carrying abstract ormize
 * type tokens, whose `type` is deliberately `unknown`.
 */
export type AuthoredAttributes = { [fieldName: string]: unknown };
