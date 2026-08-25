import { describe, it, expect } from "@jest/globals";
import {
  relayCursorCodec, plainCursorCodec, signedCursorCodec, fallbackCursorCodec, defaultCursorCodec,
} from "../../src/codecs/cursor";
import { base64 } from "../../src/graphql/utils/base64";

describe.each([
  ["relayCursorCodec", relayCursorCodec()],
  ["plainCursorCodec", plainCursorCodec()],
  ["signedCursorCodec", signedCursorCodec({secret: "s3cret"})],
])("%s", (_name, codec) => {
  it("round-trips a connection name and index", () => {
    const cursor = codec.encode({connection: "Task", index: 3});
    expect(codec.decode({value: cursor})).toEqual({connection: "Task", index: 3});
  });

  it("round-trips index 0", () => {
    expect(codec.decode({value: codec.encode({connection: "Task", index: 0})}))
      .toEqual({connection: "Task", index: 0});
  });

  it("returns null for a malformed cursor rather than throwing", () => {
    expect(codec.decode({value: "not-a-cursor"})).toBeNull();
    expect(codec.decode({value: ""})).toBeNull();
    expect(codec.decode({value: undefined as unknown as string})).toBeNull();
  });

  it("keeps the connection name distinguishable", () => {
    const a = codec.encode({connection: "Task", index: 1});
    const b = codec.encode({connection: "TaskItem", index: 1});
    expect(a).not.toEqual(b);
    expect(codec.decode({value: b})!.connection).toEqual("TaskItem");
  });
});

describe("relayCursorCodec", () => {
  it("emits exactly the format every previous version emitted", () => {
    expect(relayCursorCodec().encode({connection: "Task", index: 2}))
      .toEqual(base64(JSON.stringify(["Task", 2])));
  });

  it("is the default", () => {
    expect(defaultCursorCodec.encode({connection: "Task", index: 2}))
      .toEqual(relayCursorCodec().encode({connection: "Task", index: 2}));
  });

  it("rejects base64 that is not a [name, index] pair", () => {
    expect(relayCursorCodec().decode({value: base64(JSON.stringify({connection: "Task"}))})).toBeNull();
    expect(relayCursorCodec().decode({value: base64("{not json")})).toBeNull();
    expect(relayCursorCodec().decode({value: base64(JSON.stringify(["Task", "abc"]))})).toBeNull();
  });
});

describe("plainCursorCodec", () => {
  it("is readable", () => {
    expect(plainCursorCodec().encode({connection: "Task", index: 4})).toEqual("Task:4");
  });

  it("splits on the last colon", () => {
    expect(plainCursorCodec().decode({value: "a:b:9"})).toEqual({connection: "a:b", index: 9});
  });

  it("rejects a non-numeric index", () => {
    expect(plainCursorCodec().decode({value: "Task:abc"})).toBeNull();
    expect(plainCursorCodec().decode({value: ":4"})).toBeNull();
    expect(plainCursorCodec().decode({value: "Task"})).toBeNull();
  });
});

describe("signedCursorCodec", () => {
  const codec = signedCursorCodec({secret: "s3cret"});

  it("rejects a forged index", () => {
    const real = codec.encode({connection: "Task", index: 1});
    const forged = real.replace("Task:1.", "Task:9999.");
    expect(forged).not.toEqual(real);
    expect(codec.decode({value: forged})).toBeNull();
  });

  it("rejects a cursor signed with another secret", () => {
    const other = signedCursorCodec({secret: "other"});
    expect(codec.decode({value: other.encode({connection: "Task", index: 1})})).toBeNull();
  });

  it("rejects a truncated or padded signature without throwing", () => {
    const real = codec.encode({connection: "Task", index: 1});
    expect(codec.decode({value: real.slice(0, -1)})).toBeNull();
    expect(codec.decode({value: `${real}0`})).toBeNull();
  });

  it("refuses to be built without a secret", () => {
    expect(() => signedCursorCodec({secret: ""})).toThrow(/requires a secret/);
  });

  it("honours algorithm and length", () => {
    const short = signedCursorCodec({secret: "s3cret", algorithm: "sha512", length: 8});
    const cursor = short.encode({connection: "Task", index: 1});
    expect(cursor.slice(cursor.lastIndexOf(".") + 1)).toHaveLength(8);
    expect(short.decode({value: cursor})).toEqual({connection: "Task", index: 1});
    // a different digest is a different signature
    expect(codec.decode({value: cursor})).toBeNull();
  });
});

describe("fallbackCursorCodec", () => {
  const next = plainCursorCodec();
  const previous = relayCursorCodec();
  const codec = fallbackCursorCodec(next, previous);

  it("mints only in the new format", () => {
    expect(codec.encode({connection: "Task", index: 1}))
      .toEqual(next.encode({connection: "Task", index: 1}));
  });

  it("decodes both formats", () => {
    expect(codec.decode({value: next.encode({connection: "Task", index: 1})}))
      .toEqual({connection: "Task", index: 1});
    expect(codec.decode({value: previous.encode({connection: "Task", index: 2})}))
      .toEqual({connection: "Task", index: 2});
  });

  it("still rejects what none of them recognise", () => {
    expect(codec.decode({value: "@@@"})).toBeNull();
  });
});
