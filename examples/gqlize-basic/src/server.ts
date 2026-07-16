import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { createSchema } from "@azerothian/gqlize";
import { buildOrm } from "./orm";

async function main() {
  const orm = await buildOrm();

  // createSchema(orm, options?) returns a graphql-js GraphQLSchema.
  // Pass `{ permission }` to gate models/fields/mutations (see README).
  const schema = await createSchema(orm);

  // class/instance-method resolvers receive `context.instance`.
  const yoga = createYoga({ schema, context: () => ({ instance: orm }) });

  const port = Number(process.env.PORT) || 4000;
  createServer(yoga).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`gqlize example listening on http://localhost:${port}/graphql  (open in a browser for GraphiQL)`);
  });
}

main();
