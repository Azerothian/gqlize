import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { createSchema } from "@azerothian/gqlize";
import { buildOrm } from "./orm";

async function main() {
  const orm = await buildOrm();
  const schema = await createSchema(orm);
  const yoga = createYoga({ schema, context: () => ({ instance: orm }) });

  const port = Number(process.env.PORT) || 4000;
  createServer(yoga).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`mikro-orm example listening on http://localhost:${port}/graphql  (open in a browser for GraphiQL)`);
  });
}

main();
