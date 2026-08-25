import { GraphQLError } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import { fromCursor, toCursor } from "../objects/cursor";
import { processAfter } from "../utils/after";
import Events from "../../events";
import { defaultCursorCodec } from "../../codecs/cursor";
import type { CursorCodec } from "../../types";
import type { AdapterRelationshipPage, AdapterRow, FindAllArgs, RequestContext } from "../../types";
import type { BindingContext, DataSourceDescriptor, FieldBinding } from "./types";

/**
 * A connection field's arguments as GraphQL delivers them: the cursors are still
 * the opaque strings the client sent, and the rest of the list vocabulary
 * (`where`, `orderBy`, `first`, ...) is whatever the generated schema declared,
 * which is why only the two keys this module reads are named.
 */
type ConnectionArgs = {
  after?: string | null;
  before?: string | null;
  [arg: string]: unknown;
};

/** What a cursor decodes to — the connection that minted it, and the row's position in it. */
type DecodedCursor = {connection: string; index: number};

/**
 * Turn the opaque `after`/`before` arguments into `{connection, index}` before
 * they reach the engine, which pages off `.index` alone.
 *
 * `connection` was called `id` here, which is the confusion this seam exists to
 * remove: a cursor names a *connection*, not a row.
 */
export function processDefaultArgs(
  args: ConnectionArgs,
  codec: CursorCodec = defaultCursorCodec,
  connection?: string,
): FindAllArgs {
  // Copy wholesale, then overwrite the two cursor keys: every other argument is
  // forwarded to the adapter verbatim, and a key the client sent as an explicit
  // null has to stay present as one.
  const out: FindAllArgs = {};
  Object.assign(out, args);
  if (args.before) {
    out.before = fromCursor(args.before, codec, connection);
  }
  if (args.after) {
    out.after = fromCursor(args.after, codec, connection);
  }
  return out;
}

type ResolveData = (
  source: AdapterRow,
  args: FindAllArgs,
  context: RequestContext,
  info: GraphQLResolveInfo,
) => PromiseLike<AdapterRelationshipPage>;

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
        `gqlize: unknown connection data source "${(data as {source: string}).source}"`,
      );
  }
}

export function buildConnectionResolver(
  binding: Extract<FieldBinding, { kind: "connection" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  const name = binding.connectionName;
  const codec = ctx.options.cursor || defaultCursorCodec;
  const definition = instance.getDefinition(binding.targetDefName);
  const resolveData = buildDataSource(binding.data, ctx);

  return async function resolve(
    source: AdapterRow,
    args: ConnectionArgs,
    context: RequestContext,
    info: GraphQLResolveInfo,
  ) {
    const a = processDefaultArgs(args, codec, name);
    let cursor: DecodedCursor | null = null;
    const paged = args.after || args.before;
    if (paged) {
      cursor = fromCursor(paged, codec, name);
      // Bind the cursor to this connection: cursors are minted as
      // toCursor(name, idx), so a cursor naming a different connection was
      // reused across connections and its index is meaningless here. A codec
      // strict enough to reject it itself has already raised `Invalid cursor`
      // above; this catches the ones that merely round-trip the name.
      if (cursor && cursor.connection !== name) {
        throw new GraphQLError(`Cursor does not belong to the ${name} connection`);
      }
    }
    const { total, models } = await resolveData(source, a, context, info);
    // Carry each edge's absolute position alongside it. The page flags below need
    // it, and re-decoding the cursor just minted to get it back would make every
    // codec pay for a round trip it has no other reason to support.
    const positioned = await Promise.all(
      models.map(async (row, idx) => {
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
        const index = idx + startIndex;
        return {
          index,
          edge: {
            cursor: toCursor(name, index, codec),
            node,
          },
        };
      }),
    ).then((rows) => rows.filter((e) => e !== undefined));
    const edges = positioned.map((p) => p.edge);

    let startCursor, endCursor;
    if (edges.length > 0) {
      startCursor = edges[0].cursor;
      endCursor = edges[edges.length - 1].cursor;
    }
    let hasNextPage = false;
    let hasPreviousPage = false;
    if (positioned.length > 0) {
      // Derive page flags from the returned window's absolute position (an edge's
      // `index` is its position in the result set). This is direction-agnostic
      // and exact: there is a previous page iff the window does not start at 0,
      // and a next page iff it does not reach the last row. The previous
      // count-and-cursor arithmetic mis-handled windows starting between 1 and
      // `count`, and the forward/backward flag swap was unsound.
      const windowStart = positioned[0].index;
      const windowEnd = positioned[positioned.length - 1].index;
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
