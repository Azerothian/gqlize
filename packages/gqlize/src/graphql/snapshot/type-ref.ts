import {
  GraphQLList,
  GraphQLNonNull,
  Kind,
  parseType,
  type GraphQLNamedType,
  type GraphQLType,
  type TypeNode,
} from "graphql";

import type { TypeRef } from "./ir";

/**
 * Encode a type as its SDL reference — `"Task"`, `"Task!"`, `"[Task!]!"`.
 *
 * `String(type)` is graphql's own `toString`, so this is the printer the rest
 * of the library already agrees with rather than a hand-rolled wrapper walk.
 */
export function encodeTypeRef(type: GraphQLType): TypeRef {
  return String(type);
}

/**
 * Decode a type reference against a name lookup.
 *
 * Parsing goes through graphql's `parseType`, which makes this the provable
 * inverse of `encodeTypeRef`: both directions are graphql's own grammar, so a
 * nesting the encoder can emit is a nesting the decoder can read.
 */
export function decodeTypeRef(
  ref: TypeRef,
  lookup: (name: string) => GraphQLNamedType | undefined,
  coordinate?: string,
): GraphQLType {
  let node: TypeNode;
  try {
    node = parseType(ref);
  } catch (err: any) {
    throw new Error(
      `gqlize: could not parse type reference ${JSON.stringify(ref)}` +
        `${coordinate ? ` at ${coordinate}` : ""}: ${err.message}`,
    );
  }
  return fromTypeNode(node, lookup, ref, coordinate);
}

function fromTypeNode(
  node: TypeNode,
  lookup: (name: string) => GraphQLNamedType | undefined,
  ref: TypeRef,
  coordinate?: string,
): GraphQLType {
  switch (node.kind) {
    case Kind.NON_NULL_TYPE:
      return new GraphQLNonNull(fromTypeNode(node.type, lookup, ref, coordinate) as any);
    case Kind.LIST_TYPE:
      return new GraphQLList(fromTypeNode(node.type, lookup, ref, coordinate));
    case Kind.NAMED_TYPE: {
      const named = lookup(node.name.value);
      if (!named) {
        throw new Error(
          `gqlize: unknown type "${node.name.value}" referenced by ${JSON.stringify(ref)}` +
            `${coordinate ? ` at ${coordinate}` : ""}`,
        );
      }
      return named;
    }
  }
}
