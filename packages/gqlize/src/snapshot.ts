/**
 * Pre-generated schema artifacts.
 *
 * `snapshotSchema` turns a built `GraphQLSchema` into a serializable IR;
 * `materializeSchema` turns that IR plus a live ormize instance back into an
 * executable schema. The ormize instance is still required — it *is* the
 * resolution engine; only the type-system construction is skipped.
 *
 * `options.extend` and `options.root` are deliberately not part of the artifact
 * and are passed at load exactly as they are passed to `createSchema`.
 */
export {snapshotSchema, isJsonSerializable, type SnapshotOptions} from "./graphql/snapshot/snapshot";
export {materializeSchema, type MaterializeOptions} from "./graphql/snapshot/materialize";
export {loadSchema, readSnapshot} from "./graphql/snapshot/load";
export {
  buildArtifact,
  type BuildArtifactOptions,
  type BuildArtifactResult,
} from "./graphql/snapshot/build-artifact";
export {
  fingerprintDefinitions,
  compareFingerprints,
  FINGERPRINT_FORMAT_VERSION,
  type Fingerprint,
  type FingerprintOptions,
} from "./graphql/snapshot/fingerprint";
export {VERSION} from "./version";
export {
  createScalarRegistry,
  builtinScalars,
  type ScalarRegistry,
} from "./graphql/snapshot/scalar-registry";
export {
  SNAPSHOT_FORMAT_VERSION,
  type SchemaSnapshot,
  type NamedTypeIR,
  type ObjectTypeIR,
  type InterfaceTypeIR,
  type UnionTypeIR,
  type EnumTypeIR,
  type EnumValueIR,
  type InputObjectTypeIR,
  type ScalarTypeIR,
  type FieldIR,
  type InputValueIR,
  type TypeRef,
} from "./graphql/snapshot/ir";
export {
  LEDGER_FORMAT_VERSION,
  type GqlizeBuildLedger,
  type ExternalTypeRef,
} from "./graphql/snapshot/ledger";
export {encodeTypeRef, decodeTypeRef} from "./graphql/snapshot/type-ref";
export type {FieldBinding, DataSourceDescriptor} from "./graphql/resolvers/types";
