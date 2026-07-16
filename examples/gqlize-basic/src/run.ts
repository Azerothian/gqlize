import { graphql } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { buildOrm } from "./orm";

/**
 * Execute a few operations against the schema in-process (no HTTP server) and
 * print the results — handy for a quick look at the generated schema shape.
 */
async function main() {
  const orm = await buildOrm();
  const schema = await createSchema(orm);

  const list = await graphql({
    schema,
    source: /* GraphQL */ `
      query {
        models {
          Task {
            edges {
              node {
                id
                name
                done
              }
            }
          }
        }
      }
    `,
  });
  // eslint-disable-next-line no-console
  console.log("list:", JSON.stringify(list, null, 2));

  const created = await graphql({
    schema,
    source: /* GraphQL */ `
      mutation {
        models {
          Task(create: { name: "Buy bread" }) {
            id
            name
            done
          }
        }
      }
    `,
  });
  // eslint-disable-next-line no-console
  console.log("created:", JSON.stringify(created, null, 2));
}

main();
