// Sequelize-specific binding for the gqlize definition typesystem.
//
// This is the ONLY place the typesystem touches `sequelize`. It registers the
// `"sequelize"` base in the shared HKT registry (mapping a merged instance +
// statics pair to Sequelize's own `ModelStatic<…>`), and exposes `defineModel`
// for capturing an author's Sequelize model interface + statics.

import type { Model, ModelStatic, InferAttributes } from "sequelize";
import type {
  Definition,
} from "@azerothian/utilize/types/index";
import type {
  ITypedDefinition,
  IORModel,
  AnyTypedDef,
} from "@azerothian/utilize/types/orm";

/** Author-declared attributes of an optional-bucket instance (Model brand excluded). */
type OptionalAttrs<I> = I extends Model<any, any> ? Partial<InferAttributes<I>> : {};

/**
 * The composed Sequelize model type. The required merged instance keeps its full
 * `Model` brand (so `create()` requires its non-optional attributes); optional
 * fragments contribute only their *attributes*, made optional. Statics: the
 * required classMethods are required, optional ones become optional. The
 * `ReqInstance extends Model` gate both satisfies `ModelStatic`'s constraint and
 * preserves the required fragment's creation-attribute typing.
 */
export type SequelizeModelOf<ReqInstance, OptInstance, ReqStatics, OptStatics> =
  ReqInstance extends Model<any, any>
    ? ModelStatic<ReqInstance & OptionalAttrs<OptInstance>> & ReqStatics & Partial<OptStatics>
    : never;

// Register the sequelize base.
declare module "@azerothian/utilize/types/orm" {
  interface IORBaseRegistry<ReqInstance, OptInstance, ReqStatics, OptStatics> {
    sequelize: SequelizeModelOf<ReqInstance, OptInstance, ReqStatics, OptStatics>;
  }
}

/** The base-URI token selecting the sequelize model mapping. */
export type IORSequelizeModel = "sequelize";

/**
 * Capture a gqlize {@link Definition} together with its Sequelize instance
 * interface (`TInstance`) and static/classMethods type (`TStatics`).
 *
 * `TInstance` is written the standard Sequelize v6 way:
 * ```ts
 * interface TaskInstance extends Model<InferAttributes<TaskInstance>, InferCreationAttributes<TaskInstance>> {
 *   id: CreationOptional<string>;
 *   name: string;
 * }
 * const TaskDef = defineModel<TaskInstance, { staticMethod1(a: string, c: any): Promise<any> }>({
 *   name: "Task",
 *   define: { name: { type: Sequelize.STRING, allowNull: false } },
 *   classMethods: { async staticMethod1(a, c) { return {}; } },
 * });
 * ```
 *
 * At runtime this is the identity function — the type parameters are erased.
 */
export function defineModel<
  TInstance extends Model<any, any>,
  TStatics extends object = {},
  const D extends Definition = Definition,
>(def: D): ITypedDefinition<D["name"] & string, TInstance, TStatics> {
  return def as unknown as ITypedDefinition<D["name"] & string, TInstance, TStatics>;
}

/**
 * The Sequelize model type composed from a required (and optional) bucket of
 * typed definitions. Convenience alias for `IORModel<IORSequelizeModel, …>`.
 *
 * ```ts
 * type TaskModel = SequelizeModel<[typeof TaskV1], [typeof TaskV2]>;
 * ```
 */
export type SequelizeModel<
  Req extends readonly AnyTypedDef[],
  Opt extends readonly AnyTypedDef[] = [],
> = IORModel<IORSequelizeModel, Req, Opt>;

// Re-export the Sequelize helper types authors need to declare instance
// interfaces, so they can import everything from the adapter.
export type {
  Model,
  ModelStatic,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  CreationAttributes,
  Attributes,
  ForeignKey,
  NonAttribute,
} from "sequelize";
