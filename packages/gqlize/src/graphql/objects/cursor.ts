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
import { unbase64, base64 } from "../utils/base64";

export function fromCursor(cursor: string) {
  // Cursors are client-supplied — decode defensively. A malformed `after`/
  // `before` value must surface as a clean GraphQLError, not an uncaught
  // JSON.parse SyntaxError leaking parser internals to the caller.
  let decoded: any;
  try {
    decoded = JSON.parse(unbase64(cursor));
  } catch {
    throw new GraphQLError("Invalid cursor");
  }
  if (!Array.isArray(decoded)) {
    throw new GraphQLError("Invalid cursor");
  }
  const [id, index] = decoded;
  const idx = parseInt(index, 10);
  if (typeof id !== "string" || Number.isNaN(idx)) {
    throw new GraphQLError("Invalid cursor");
  }
  return {
    id,
    index: idx,
  };
}
export function toCursor(id: string, index: number) {
  return base64(JSON.stringify([id, index]));
}
