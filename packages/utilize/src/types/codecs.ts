/**
 * Id and cursor codecs — the seam between opaque client-facing tokens and the
 * raw values the engine works with.
 */

import type { GlobalKeyTargets } from "./selection";

/**
 * How a row's primary/foreign key becomes the opaque id a client sees, and back.
 *
 * Every id gqlize hands out crosses this seam exactly once in each direction, so
 * a codec is the whole vocabulary: swap it and `node(id:)`, `where` filters,
 * mutation inputs and auto-include all speak the new format together. The
 * default (`relayIdCodec`) is base64 `Type:id`, which is what 7.x and every
 * earlier version emitted.
 */
export type IdCodec = {
  /** row value -> the opaque id the client sees. */
  encode(ctx: {type: string; id: string | number; defName: string; fieldName: string}): string;
  /**
   * opaque id -> raw value, or `null` when `value` is not one of this codec's
   * ids — callers leave it untouched rather than corrupting it.
   *
   * That `null` is load-bearing in both directions. A raw primary key typed into
   * a global-key filter or mutation input must survive unchanged (`fromGlobalId`
   * turns `"42"` into `""` without complaining, which is how a raw pk used to be
   * silently written away), and a codec that only recognises its own format is
   * what lets `fallbackCursorCodec`-style layering work for ids too.
   *
   * `type` is the expected target type when the caller knows it (pk: the model;
   * fk: `foreignTarget`), passed as context only. A codec must **not** reject a
   * cross-type id by returning `null` — that is indistinguishable from "not one
   * of mine", which is a passthrough. gqlize compares the decoded type against
   * `type` itself (`packages/gqlize/src/utils/decode-id.ts`) and raises a
   * `GraphQLError`, because only that layer can name the offending field.
   */
  decode(ctx: {value: string; type?: string; defName?: string; fieldName?: string}):
    {type: string; id: string} | null;
  /**
   * False when an id does not carry its type. `node(id:)` cannot work without it
   * — it has nothing but the id to decide which model to fetch — so `createSchema`
   * warns once and omits the `node` field rather than shipping one that returns
   * null for everything.
   *
   * Absent means true: a codec that says nothing is assumed to round-trip the
   * type, which is what every shipped codec but `rawIdCodec` does.
   */
  carriesType?: boolean;
};

/**
 * How a connection's edge position becomes the opaque cursor a client sees.
 *
 * A cursor is not an id: it carries a **connection name and an absolute row
 * index**, not a primary key. `index` must round-trip as an exact integer — it is
 * consumed as arithmetic when deriving `OFFSET`, `hasNextPage` and
 * `hasPreviousPage` — and `connection` must survive too, because a cursor minted
 * by one connection has a meaningless index in another and is rejected on that
 * basis.
 */
export type CursorCodec = {
  encode(ctx: {connection: string; index: number}): string;
  /**
   * `null` for anything this codec did not mint; the caller raises
   * `Invalid cursor`. Codecs never throw and never import `graphql`: one caller
   * turns a failure into a `GraphQLError` and another (the nested-relation
   * offset planner) swallows it, and neither wants the codec to know which.
   *
   * `connection` is the connection asking, when there is one. It is absent where
   * the caller cannot name it — the eager-load planner reads a nested
   * connection's `after`/`before` before that connection's resolver runs — so a
   * codec that checks ownership must only do so when it is given something to
   * check against.
   */
  decode(ctx: {value: string; connection?: string}): {connection: string; index: number} | null;
};

/**
 * What a caller hands the shared id decoder: the codec, and what it knows about
 * the keys being decoded.
 *
 * Travels as a trailing parameter on the adapter contract's `replaceIdIn*` hooks
 * rather than replacing the `variableValues` argument beside it, so an
 * out-of-tree adapter that ignores it keeps working — on the default codec,
 * which is the only format it could have been built against.
 */
export type IdTranslation = {
  /** default: the base64 `Type:id` relay codec */
  codec?: IdCodec;
  /** what each global key points at, so a cross-type id can be rejected */
  targets?: GlobalKeyTargets;
  /** the model the keys belong to; passed to the codec as context only */
  defName?: string;
};
