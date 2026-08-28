import { validateSchema, type GraphQLSchema } from "graphql";

/** Where the schema being checked came from, which decides what advice fits. */
export type SchemaOrigin = "build" | "artifact";

const ADVICE: Record<SchemaOrigin, string> = {
  build:
    "Most often this is a type written into `options.root`, `options.extend` or a definition's " +
    "`override` / `expose` block. Pass `validate: false` to skip this check.",
  artifact:
    "The artifact and the definitions it is being materialized against have diverged. Rebuild it " +
    "(`gqlize build`), or pass `validate: false` to skip this check.",
};

/**
 * Fail the build on a schema graphql itself considers invalid.
 *
 * graphql validates lazily — once per *execution*, cached on the schema — and
 * returns the same error list for every operation. So one invalid field does not
 * fail only the query that selects it: it fails every query against the schema,
 * at request time, with a message that names the offending coordinate but not
 * the code that produced it. `createSchema` and `materializeSchema` therefore
 * both check here, where the mistake was actually made.
 *
 * This is the same `validateSchema` graphql would run anyway, so the result is
 * memoized on the schema and the work is not repeated at execution time.
 */
export default function assertSchemaValid(
  schema: GraphQLSchema,
  origin: SchemaOrigin,
  validate: boolean | undefined,
) {
  if (validate === false) {
    return schema;
  }
  const errors = validateSchema(schema);
  if (errors.length === 0) {
    return schema;
  }
  const detail = errors.map((error) => `  - ${error.message}`).join("\n");
  const error = new Error(
    `gqlize: the ${origin === "build" ? "generated" : "materialized"} schema is not a valid ` +
    `GraphQL schema:\n${detail}\n${ADVICE[origin]}`,
  );
  // The originals carry the coordinates and any AST nodes; keep them reachable
  // rather than collapsing everything into the message above.
  (error as Error & {errors?: readonly unknown[]}).errors = errors;
  throw error;
}
