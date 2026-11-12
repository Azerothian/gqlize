// MikroORM-specific binding for the ormize definition typesystem.
//
// This is the only place the typesystem touches MikroORM. It registers the
// `"mikro-orm"` base in the shared HKT registry, so `ormize.models.*` resolves
// to a {@link MikroModel} rather than the default, and provides the identity
// helper an author uses to name their entity map.

import type { IORModel, AnyTypedDef } from "@azerothian/utilize/types/orm";
import type { MikroModelStatics, MikroModel } from "../model";

/**
 * The composed model type for a MikroORM entity.
 *
 * The required merged instance is the entity; optional fragments contribute
 * theirs as optional. Statics: the required class methods are required, optional
 * ones become optional — the same split the SQL adapter's mapping makes, for the
 * same reason (`registerAdapter`/`define` decide which bucket a fragment is in).
 */
export type MikroModelOf<ReqInstance, OptInstance, ReqStatics, OptStatics> =
  ReqInstance extends object
    ? MikroModel<ReqInstance & Partial<OptInstance>>
      & MikroModelStatics<ReqInstance & Partial<OptInstance>>
      & ReqStatics & Partial<OptStatics>
    : never;

// Register the mikro-orm base.
declare module "@azerothian/utilize/types/orm" {
  interface IORBaseRegistry<ReqInstance, OptInstance, ReqStatics, OptStatics> {
    "mikro-orm": MikroModelOf<ReqInstance, OptInstance, ReqStatics, OptStatics>;
  }
}

/** The base-URI token selecting the mikro-orm model mapping. */
export type IORMikroModel = "mikro-orm";

/**
 * The MikroORM model type composed from a required (and optional) bucket of
 * typed definitions. Convenience alias for `IORModel<IORMikroModel, …>`.
 */
export type MikroDefinedModel<
  Req extends readonly AnyTypedDef[],
  Opt extends readonly AnyTypedDef[] = [],
> = IORModel<IORMikroModel, Req, Opt>;

/**
 * Name the entity map an adapter contributes, for readability at the call site:
 *
 * ```ts
 * type Entities = typeof entities;
 * const entities = defineEntities<{ User: User; Article: Article }>();
 * new MikroAdapter<Entities>(mikro);
 * ```
 *
 * The map is written out rather than inferred from the entity list because
 * `typeof User` carries `name: string`, not the literal `"User"` — there is no
 * key to infer. At runtime this is the identity: the type parameter is erased.
 */
export function defineEntities<TEntities extends Record<string, object>>(): TEntities {
  return {} as TEntities;
}
