import { GraphQLError } from "graphql";
import { fromCursor, toCursor } from "../objects/cursor";
import { processAfter } from "../utils/after";
import Events from "../../events";
import type { BindingContext, DataSourceDescriptor, FieldBinding } from "./types";

export function processDefaultArgs(args: { before: string; after: string }) {
  const newArgs: any = {};
  if (args.before) {
    newArgs.before = fromCursor(args.before);
  }
  if (args.after) {
    newArgs.after = fromCursor(args.after);
  }
  return {
    ...args,
    ...newArgs,
  };
}

type ResolveData = (
  source: any,
  args: any,
  context: any,
  info: any,
) => PromiseLike<{ total: any; models: any }>;

/**
 * Rebuilds the page-fetching callback a connection used to receive as a closure.
 * Kept separate from the connection resolver so both the live builder and the
 * artifact materializer produce byte-identical behaviour from the descriptor.
 */
export function buildDataSource(data: DataSourceDescriptor, ctx: BindingContext): ResolveData {
  const { instance } = ctx;
  switch (data.source) {
    case "findAll":
      return (source, args, context, info) =>
        instance.resolveFindAll(data.defName, source, args, context, info);
    case "manyRelationship": {
      const associations = instance.getAssociations(data.parentDefName);
      const association = associations?.[data.relName];
      if (!association) {
        throw new Error(
          `gqlize: relationship "${data.relName}" not found on "${data.parentDefName}"`,
        );
      }
      return (source, args, context, info) =>
        instance.resolveManyRelationship(
          data.defName,
          association,
          source,
          args,
          context,
          info,
        );
    }
    default:
      throw new Error(
        `gqlize: unknown connection data source "${(data as any).source}"`,
      );
  }
}

export function buildConnectionResolver(
  binding: Extract<FieldBinding, { kind: "connection" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  const name = binding.connectionName;
  const definition = instance.getDefinition(binding.targetDefName);
  const resolveData = buildDataSource(binding.data, ctx);

  return async function resolve(
    source: any,
    args: { after: any; before: any; first: any; last: any },
    context: any,
    info: any,
  ) {
    const a = processDefaultArgs(args);
    let cursor: { index: any; id?: any } | null = null;
    if (args.after || args.before) {
      cursor = fromCursor(args.after || args.before);
      // Bind the cursor to this connection: cursors are minted as
      // toCursor(name, idx), so a cursor whose id is a different connection's
      // name was reused across connections and its index is meaningless here.
      if (cursor && cursor.id !== name) {
        throw new GraphQLError(`Cursor does not belong to the ${name} connection`);
      }
    }
    const { total, models } = await resolveData(source, a, context, info);
    const edges = await Promise.all(
      models.map(async (row: any, idx: number) => {
        const node = await processAfter(row, a, context, info, definition, Events.OUTPUT);
        if (!node) {
          return undefined;
        }
        let startIndex = null;
        if (cursor) {
          startIndex = Number(cursor.index);
        }
        if (startIndex !== null) {
          startIndex++;
        } else {
          startIndex = 0;
        }
        return {
          cursor: toCursor(name, idx + startIndex),
          node,
        };
      }),
    ).then((edges: any) => edges.filter((e: any) => e !== undefined && e !== null));

    let startCursor, endCursor;
    if (edges.length > 0) {
      startCursor = edges[0].cursor;
      endCursor = edges[edges.length - 1].cursor;
    }
    let hasNextPage = false;
    let hasPreviousPage = false;
    if (edges.length > 0) {
      // Derive page flags from the returned window's absolute position (edge
      // cursors encode `position` = index-in-result-set). This is direction-
      // agnostic and exact: there is a previous page iff the window does not
      // start at 0, and a next page iff it does not reach the last row. The
      // previous count-and-cursor arithmetic mis-handled windows starting
      // between 1 and `count`, and the forward/backward flag swap was unsound.
      const windowStart = fromCursor(edges[0].cursor).index;
      const windowEnd = fromCursor(edges[edges.length - 1].cursor).index;
      hasPreviousPage = windowStart > 0;
      hasNextPage = windowEnd < total - 1;
    }
    return {
      pageInfo: {
        hasNextPage,
        hasPreviousPage,
        startCursor,
        endCursor,
      },
      total,
      edges,
    };
  };
}
