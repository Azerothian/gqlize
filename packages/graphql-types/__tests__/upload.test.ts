import {describe, expect, it} from "@jest/globals";
import {parseValue as parseLiteralNode} from "graphql";
import UploadType from "../src/upload";

describe("graphql-types - GQLTUpload", () => {
  it("passes the upload promise through untouched on the variable path", () => {
    const promise = Promise.resolve({filename: "a.txt"});
    expect(UploadType.parseValue(promise)).toBe(promise);
  });
  it("refuses the literal and output paths", () => {
    // An upload only ever arrives as a multipart variable: there is no literal
    // syntax for one, and it is an input-only type so it is never serialized.
    expect(() => UploadType.parseLiteral!(parseLiteralNode(`"a.txt"`), undefined)).toThrow("Upload scalar literal unsupported");
    expect(() => UploadType.serialize("a.txt")).toThrow("Upload scalar serialization unsupported");
  });
});
