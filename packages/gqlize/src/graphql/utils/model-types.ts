/**
 * Keep only the model-type keys a schema actually publishes.
 *
 * The builder's type cache carries a `"Name[]"` list wrapper beside each
 * `"Name"` (`create-model-type.ts`). A list is not a named type and can never be
 * looked up on its own, so the wrapper is kept exactly when its base is.
 *
 * A model can be built and still be published nowhere: deny both its query list
 * field and its mutation entry and nothing in the schema refers to it, so
 * `new GraphQLSchema` never walks it into the type map. Recording such a name in
 * `ledger.modelTypes` makes the artifact inconsistent at birth — the snapshot's
 * reachability walk has no type to carry for it, and the loader throws. Pruning
 * here keeps the ledger, the `$sql2gql` hatch and the relay node map on the same
 * key set as the schema they belong to.
 *
 * Key order is preserved and the input is left untouched.
 */
export default function pruneModelTypes<T>(
  types: {[name: string]: T},
  isPublished: (name: string) => boolean,
): {[name: string]: T} {
  const out: {[name: string]: T} = {};
  for (const name of Object.keys(types)) {
    const base = name.endsWith("[]") ? name.slice(0, -2) : name;
    if (isPublished(base)) {
      out[name] = types[name];
    }
  }
  return out;
}
