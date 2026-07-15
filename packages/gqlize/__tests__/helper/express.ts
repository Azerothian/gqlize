import {createServer} from "node:http";
import {createYoga} from "graphql-yoga";

import {createInstance} from "./index";
import {createSchema} from "../../src";

const PORT = 3005;

(async() => {
  const instance = await createInstance();
  const schema = await createSchema(instance);
  const yoga = createYoga({
    schema,
    context: () => ({instance}),
  });
  const server = createServer(yoga);
  server.listen(PORT, () => {
    console.log("success", PORT, `http://localhost:${PORT}${yoga.graphqlEndpoint}`);
  });
})().catch((err) => {
  console.log("ERR", err);
});
