/*

The MIT License (MIT)

Copyright (c) 2015 Mick Hansen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// https://github.com/mickhansen/graphql-sequelize/blob/master/src/relay.js
import type { GraphQLResolveInfo } from "graphql";
import { isModelAllowed } from "@azerothian/utilize";
import { defaultIdCodec } from "../../codecs/id";
import { processAfter } from "./after";
import Events from "../../events";
import type NodeTypeMapper from "./node-type-mapper";
import type GQLManager from "../../manager";
import type { GqlizeOptions, RequestContext } from "../../types";

/**
 * Relay `node(id)` resolver.
 *
 * SECURITY: this used to fall through to a raw `models[type].findByPk(id)` with
 * no `context`, no permission gate, and without the `definition.after`
 * (Events.OUTPUT) redaction hook that every other resolver runs — a global,
 * enumerable object-read that bypassed per-request/tenant scoping. It now:
 *   1. honours model + `permission.query` authorization (same gates as the
 *      `models` query),
 *   2. fetches through the authorized `resolveFindAll` path (so
 *      `definition.before` context scoping applies), and
 *   3. runs the OUTPUT hook on the result before returning it.
 */
export default function idFetcher(
  instance: GQLManager,
  nodeTypeMapper: NodeTypeMapper,
  options: GqlizeOptions | undefined,
) {
  return async(globalId: string, context: RequestContext, info: GraphQLResolveInfo) => {
    if (globalId === null || globalId === undefined) {
      return null;
    }
    // `node(id:)` has nothing but the id to go on, so the type has to come back
    // out of it. A codec that cannot carry one (`carriesType: false`) never
    // reaches here - the field is omitted from the schema at build time.
    const codec = options?.id || defaultIdCodec;
    const decoded = codec.decode({value: globalId});
    if (!decoded) {
      return null;
    }
    const {type} = decoded;

    // Preserve any custom node resolver registered via the type mapper.
    const nodeType = nodeTypeMapper.item(type);
    if (nodeType && typeof nodeType.resolve === "function") {
      const res = await Promise.resolve(nodeType.resolve(globalId, context, info));
      if (res) {
        (res as {__graphqlType__?: string}).__graphqlType__ = type;
      }
      return res;
    }

    const definition = instance.getDefinition ? instance.getDefinition(type) : undefined;
    if (!definition) {
      // Not a fetchable model type — fall back to legacy schema-type resolution.
      if (nodeType) {
        return typeof nodeType.type === "string" ? info.schema.getType(nodeType.type) : nodeType.type;
      }
      return null;
    }

    // Authorization — mirror the `models` query gates. Absent permission = allow.
    if (!isModelAllowed(options?.permission, type)) {
      return null;
    }
    if (options?.permission?.query) {
      const allowed = options.permission.query(type, options.permission.options);
      if (!allowed) {
        return null;
      }
    }

    // Resolve the primary-key column so we can fetch through the authorized list
    // path rather than a raw, unscoped findByPk.
    const fields = instance.getFields(type);
    const pkName = Object.keys(fields).find((k) => fields[k].primaryKey);
    if (!pkName) {
      return null;
    }

    // Pass the ORIGINAL global id as the pk filter value: resolveFindAll runs
    // replaceIdInArgs, which decodes global ids on primary/foreign-key fields
    // back to the raw value. `info` is intentionally omitted so the interface-
    // level selection does not restrict which columns are loaded.
    const { models } = await instance.resolveFindAll(
      type,
      null,
      { where: { [pkName]: globalId }, first: 1 },
      context,
      undefined,
    );
    const record = models && models[0];
    if (!record) {
      return null;
    }

    // Apply the OUTPUT hook (redaction/authorization) as the other resolvers do.
    const node = await processAfter(record, {}, context, info, definition, Events.OUTPUT);
    if (!node) {
      return null;
    }
    // The stamp `typeResolver` reads back to decide which object type a `node`
    // result is; not a column, so it has to be hung off the row.
    (node as {__graphqlType__?: string}).__graphqlType__ = type;
    return node;
  };
}
