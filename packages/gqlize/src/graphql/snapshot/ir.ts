import type { FieldBinding } from "../resolvers/types";
import type { Fingerprint } from "./fingerprint";
import type { GqlizeBuildLedger } from "./ledger";

export const SNAPSHOT_FORMAT_VERSION = 1;

/**
 * A type reference in SDL syntax — `"Task"`, `"Task!"`, `"[Task!]!"`.
 *
 * Encoded with `String(type)` and decoded with graphql's own `parseType`, so
 * the two directions are each other's inverse by construction rather than by
 * a hand-written wrapper walk that has to be kept in sync.
 */
export type TypeRef = string;

export interface InputValueIR {
  name: string;
  type: TypeRef;
  description?: string;
  deprecationReason?: string;
  /** GraphQL const-literal source text, e.g. `"10"`, `'{a: 1}'` */
  defaultLiteral?: string;
}

export interface FieldIR {
  name: string;
  type: TypeRef;
  description?: string;
  deprecationReason?: string;
  args?: InputValueIR[];
  /** absent for fields that use graphql's default property resolver */
  binding?: FieldBinding;
}

export interface EnumValueIR {
  name: string;
  description?: string;
  deprecationReason?: string;
  /**
   * The enum's *internal* value — omitted when it equals `name`.
   *
   * This is the field SDL cannot carry. `TaskOrderBy.nameASC` holds
   * `["name", "ASC"]` and is handed straight to the backend's `order`; printing
   * and re-parsing the schema turns it into the string `"nameASC"` with no
   * error anywhere. Carrying it is the reason this IR exists instead of SDL.
   */
  value?: unknown;
}

export interface ObjectTypeIR {
  kind: "object";
  name: string;
  description?: string;
  interfaces?: string[];
  fields: FieldIR[];
  /** set when this is a generated model type, so `$sql2gql` can be reattached */
  model?: { defName: string };
}

export interface InterfaceTypeIR {
  kind: "interface";
  name: string;
  description?: string;
  interfaces?: string[];
  fields: FieldIR[];
}

export interface UnionTypeIR {
  kind: "union";
  name: string;
  description?: string;
  types: string[];
}

export interface EnumTypeIR {
  kind: "enum";
  name: string;
  description?: string;
  values: EnumValueIR[];
}

export interface InputObjectTypeIR {
  kind: "input";
  name: string;
  description?: string;
  fields: InputValueIR[];
  isOneOf?: boolean;
}

export interface ScalarTypeIR {
  kind: "scalar";
  name: string;
  description?: string;
  /** key into the scalar registry — coercion is code and cannot be serialized */
  registryKey: string;
  specifiedByURL?: string;
}

export type NamedTypeIR =
  | ObjectTypeIR
  | InterfaceTypeIR
  | UnionTypeIR
  | EnumTypeIR
  | InputObjectTypeIR
  | ScalarTypeIR;

export interface SchemaSnapshot {
  formatVersion: number;
  /** absent artifacts load, but skip the staleness check with a warning */
  fingerprint?: Fingerprint;
  description?: string;
  query: string;
  mutation?: string;
  /** in `getTypeMap()` insertion order */
  types: NamedTypeIR[];
  ledger: GqlizeBuildLedger;
}
