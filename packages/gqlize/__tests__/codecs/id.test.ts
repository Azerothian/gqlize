import { describe, it, expect } from "@jest/globals";
import { fromGlobalId, toGlobalId } from "graphql-relay";
import { relayIdCodec, prefixIdCodec, rawIdCodec, defaultIdCodec } from "../../src/codecs/id";

const ctx = (type: string, id: string | number) =>
  ({type, id, defName: type, fieldName: "id"});

describe("relayIdCodec", () => {
  const codec = relayIdCodec();

  it("is byte-identical to graphql-relay in both directions", () => {
    expect(codec.encode(ctx("Task", 42))).toEqual(toGlobalId("Task", "42"));
    const encoded = toGlobalId("Task", "42");
    expect(codec.decode({value: encoded})).toEqual({type: "Task", id: "42"});
    expect(fromGlobalId(codec.encode(ctx("Task", 42)))).toEqual({type: "Task", id: "42"});
  });

  it("is the default", () => {
    expect(defaultIdCodec.encode(ctx("Task", 1))).toEqual(toGlobalId("Task", "1"));
    expect(defaultIdCodec.carriesType).toBe(true);
  });

  // `fromGlobalId("42")` returns `{type: "", id: ""}` rather than throwing — the
  // value used to be written straight through as `""`. See bug 1 in #42.
  it("returns null for a raw key rather than an empty type/id", () => {
    expect(codec.decode({value: "42"})).toBeNull();
    expect(codec.decode({value: ""})).toBeNull();
    expect(codec.decode({value: "not base64!"})).toBeNull();
    // valid base64, decodes to bytes with no colon
    expect(codec.decode({value: "deadbeef"})).toBeNull();
  });

  // bug 2 in #42: the type half was decoded and thrown away.
  it("refuses an id minted for a different type", () => {
    const taskId = toGlobalId("Task", "1");
    expect(codec.decode({value: taskId, type: "Task"})).toEqual({type: "Task", id: "1"});
    expect(codec.decode({value: taskId, type: "Post"})).toBeNull();
    // no expected type = no check, as before
    expect(codec.decode({value: taskId})).toEqual({type: "Task", id: "1"});
  });
});

describe("prefixIdCodec", () => {
  const codec = prefixIdCodec({prefixes: {Task: "TSK", TaskItem: "TSKI", Item: "ITM"}, pad: 6});

  it("round-trips with padding stripped", () => {
    expect(codec.encode(ctx("Task", 42))).toEqual("TSK000042");
    expect(codec.decode({value: "TSK000042"})).toEqual({type: "Task", id: "42"});
  });

  it("matches the longest prefix, not map order", () => {
    expect(codec.decode({value: codec.encode(ctx("TaskItem", 7))})).toEqual({type: "TaskItem", id: "7"});
  });

  it("type-checks like the relay codec", () => {
    const id = codec.encode(ctx("Task", 1));
    expect(codec.decode({value: id, type: "Item"})).toBeNull();
    expect(codec.decode({value: id, type: "Task"})).toEqual({type: "Task", id: "1"});
  });

  it("leaves an unrecognised value alone", () => {
    expect(codec.decode({value: "42"})).toBeNull();
    expect(codec.decode({value: "TSK"})).toBeNull();
  });

  it("refuses to mint an id for a type with no prefix", () => {
    expect(() => codec.encode(ctx("Person", 1))).toThrow(/no prefix for type "Person"/);
  });

  it("does not pad when pad is 0", () => {
    const plain = prefixIdCodec({prefixes: {Task: "task_"}});
    expect(plain.encode(ctx("Task", "abc"))).toEqual("task_abc");
    expect(plain.decode({value: "task_abc"})).toEqual({type: "Task", id: "abc"});
  });
});

describe("rawIdCodec", () => {
  const codec = rawIdCodec();

  it("is the identity, and says it carries no type", () => {
    expect(codec.carriesType).toBe(false);
    expect(codec.encode(ctx("Task", 42))).toEqual("42");
    expect(codec.decode({value: "42", type: "Task"})).toEqual({type: "Task", id: "42"});
    expect(codec.decode({value: "42"})).toEqual({type: "", id: "42"});
  });
});
