/**
 * Typed introspection helpers for schemas built in tests.
 *
 * A generated schema is walked constantly in these tests — "the `models`
 * field's type has a `Task` field whose type has an `edges` field..." — and
 * every hop through a `GraphQLOutputType`/`GraphQLInputType` union needs
 * narrowing before `.getFields()` is callable on it. Doing that narrowing once
 * here, with a thrown error naming what was expected, beats an `as any` at
 * every call site: a wrong assumption fails with "expected X to be a
 * GraphQLObjectType" instead of `undefined is not a function` three hops
 * later.
 */
import {
  GraphQLEnumType,
  GraphQLField,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
} from "graphql";

/** Strip `GraphQLNonNull`/`GraphQLList` wrappers down to the named type underneath. */
export function unwrapType(type: GraphQLOutputType | GraphQLInputType): GraphQLNamedType {
  let current = type;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList) {
    current = current.ofType;
  }
  return current;
}

function describe(type: GraphQLNamedType | undefined | null): string {
  return type ? `${type.constructor.name} "${type.name}"` : "undefined";
}

export function asObjectType(type: GraphQLNamedType): GraphQLObjectType {
  if (!(type instanceof GraphQLObjectType)) {
    throw new Error(`Expected a GraphQLObjectType, got ${describe(type)}`);
  }
  return type;
}

export function asInputObjectType(type: GraphQLNamedType): GraphQLInputObjectType {
  if (!(type instanceof GraphQLInputObjectType)) {
    throw new Error(`Expected a GraphQLInputObjectType, got ${describe(type)}`);
  }
  return type;
}

export function asEnumType(type: GraphQLNamedType): GraphQLEnumType {
  if (!(type instanceof GraphQLEnumType)) {
    throw new Error(`Expected a GraphQLEnumType, got ${describe(type)}`);
  }
  return type;
}

/** `schema.getType(name)`, asserted to be an object type. */
export function objectType(schema: GraphQLSchema, name: string): GraphQLObjectType {
  return asObjectType(unwrapType(nonNullGetType(schema, name)));
}

/** `schema.getType(name)`, asserted to be an input object type. */
export function inputObjectType(schema: GraphQLSchema, name: string): GraphQLInputObjectType {
  return asInputObjectType(unwrapType(nonNullGetType(schema, name)));
}

/** `schema.getType(name)`, asserted to be an enum type. */
export function enumType(schema: GraphQLSchema, name: string): GraphQLEnumType {
  return asEnumType(unwrapType(nonNullGetType(schema, name)));
}

function nonNullGetType(schema: GraphQLSchema, name: string): GraphQLNamedType {
  const type = schema.getType(name);
  if (!type) {
    throw new Error(`Expected schema to have a type named "${name}"`);
  }
  return type;
}

export function queryType(schema: GraphQLSchema): GraphQLObjectType {
  const type = schema.getQueryType();
  if (!type) {
    throw new Error("Schema has no query type");
  }
  return type;
}

export function mutationType(schema: GraphQLSchema): GraphQLObjectType {
  const type = schema.getMutationType();
  if (!type) {
    throw new Error("Schema has no mutation type");
  }
  return type;
}

function getField<TSource, TContext>(type: GraphQLObjectType<TSource, TContext>, name: string): GraphQLField<TSource, TContext> {
  const field = type.getFields()[name];
  if (!field) {
    throw new Error(`Expected field "${name}" on type "${type.name}" to be defined`);
  }
  return field;
}

/** The object type a field's (possibly `NonNull`/`List`-wrapped) output type resolves to. */
export function fieldObjectType<TSource, TContext>(field: GraphQLField<TSource, TContext>): GraphQLObjectType {
  return asObjectType(unwrapType(field.type));
}

/** The input object type an argument's (possibly wrapped) input type resolves to. */
export function argInputObjectType(arg: {type: GraphQLInputType}): GraphQLInputObjectType {
  return asInputObjectType(unwrapType(arg.type));
}

/** The input object type an input field's (possibly wrapped) input type resolves to. */
export function inputFieldInputObjectType(field: GraphQLInputField): GraphQLInputObjectType {
  return asInputObjectType(unwrapType(field.type));
}

/**
 * Walk a chain of field names off an object type, resolving each hop's output
 * type to the next object type. Mirrors the generated schema's own shape —
 * `models.Task.edges.node`, say — without every intermediate `.type` needing
 * to be narrowed by hand.
 */
export function walkFields(type: GraphQLObjectType, ...path: string[]): GraphQLObjectType {
  return path.reduce((current, name) => fieldObjectType(getField(current, name)), type);
}

export {getField as fieldOn};
