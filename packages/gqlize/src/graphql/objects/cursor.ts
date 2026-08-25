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

import { GraphQLError } from "graphql";
import { defaultCursorCodec } from "../../codecs/cursor";
import type { CursorCodec } from "../../types";

/**
 * The connection-cursor seam.
 *
 * The base64 `[connection, index]` format that used to be inlined here is now
 * `relayCursorCodec()` in `codecs/cursor.ts` — still the default, byte for byte.
 * What is left is the pair of helpers that adapt a codec to the two callers:
 * one wants a `GraphQLError` on bad input, the other wants a `null` it can plan
 * around.
 */

/**
 * Decode a client-supplied cursor, or fail the request.
 *
 * A malformed `after`/`before` must surface as a clean `GraphQLError` rather than
 * paging from offset 0 as if nothing had happened — silently serving page one to
 * a client that asked for page nine is worse than an error.
 */
export function fromCursor(cursor: string, codec: CursorCodec = defaultCursorCodec, connection?: string) {
  const decoded = tryFromCursor(cursor, codec, connection);
  if (!decoded) {
    throw new GraphQLError("Invalid cursor");
  }
  return decoded;
}

/** As {@link fromCursor}, but `null` instead of a throw. */
export function tryFromCursor(cursor: string, codec: CursorCodec = defaultCursorCodec, connection?: string) {
  try {
    return codec.decode({value: cursor, connection});
  } catch {
    // A codec is not supposed to throw, but a third-party one might; a bad
    // cursor is a bad cursor either way.
    return null;
  }
}

export function toCursor(connection: string, index: number, codec: CursorCodec = defaultCursorCodec) {
  return codec.encode({connection, index});
}
