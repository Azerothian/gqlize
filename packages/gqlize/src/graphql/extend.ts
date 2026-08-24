import waterfall from "@azerothian/utilize/utils/waterfall";
import { GqlizeOptions } from "../types";
import { bindField } from "./resolvers/bind";
import type { BindingContext } from "./resolvers/types";
import type { GqlizeBuildLedger } from "./snapshot/ledger";

/**
 * Merges `options.extend.{query,mutation}` into the root field map, running the
 * `queryExtension` / `mutationExtension` permission gate on each key.
 *
 * `extend` fields are arbitrary user configs with arbitrary resolvers, so they
 * are never serialized — they are supplied again at load time and merged here.
 * Both `createSchemaObjects` and the snapshot materializer call this, so the
 * merge order and permission behaviour cannot diverge between the two paths.
 */
export async function applyExtendFields(
  fields: Record<string, any>,
  extendFields: Record<string, any> | undefined,
  target: "query" | "mutation",
  options: GqlizeOptions,
  ctx: BindingContext,
  ledger?: GqlizeBuildLedger,
): Promise<Record<string, any>> {
  if (!extendFields) {
    return fields;
  }
  const gate = target === "query"
    ? options.permission?.queryExtension
    : options.permission?.mutationExtension;

  return waterfall(Object.keys(extendFields), async(k: string, o: Record<string, any>) => {
    if (gate) {
      const result = await gate(k, options.permission?.options);
      if (!result) {
        return o;
      }
    }
    o[k] = bindField(extendFields[k], {kind: "extend", target, key: k}, ctx);
    if (ledger) {
      ledger.extendFields[target].push(k);
    }
    return o;
  }, fields);
}
