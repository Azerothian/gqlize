import { graphql } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { buildOrm } from "./orm";

/** One query against the generated schema, printed — no server needed. */
async function main() {
  const orm = await buildOrm();
  const schema = await createSchema(orm);

  const result = await graphql({
    schema,
    contextValue: { instance: orm },
    source: `{
      models {
        Item {
          edges { node {
            id
            label
            tasks(orderBy: [nameASC]) {
              total
              edges { node { id name done itemId } }
            }
          } }
        }
      }
    }`,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main();
