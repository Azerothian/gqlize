import {createInstance} from "./helper";
import {createSchema} from "../src";
import {objectType} from "./helper/graphql-introspection";
import {describe, it, expect} from "@jest/globals";
describe("comments", () => {
  it("classMethod", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemClassMethodsType = objectType(schema, "ItemMutationsClassMethods");
    expect(itemClassMethodsType.getFields().reverseName.description).toEqual("reverseName comment");
  });


  it("instanceMethod", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemType = objectType(schema, "Item");
    expect(itemType.getFields().testInstanceMethod.description).toEqual("testInstanceMethod comment");
  });

  it("field", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemType = objectType(schema, "Item");
    expect(itemType.getFields().name.description).toEqual("name comment");
  });
  it("relationship - singular", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemType = objectType(schema, "Item");
    expect(itemType.getFields().hasOne.description).toEqual("hasOne comment");
  });
  it("relationship - list", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemType = objectType(schema, "Item");
    expect(itemType.getFields().children.description).toEqual("children comment");
  });
  it("model", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const itemType = objectType(schema, "Item");
    expect(itemType.description).toEqual("item comment");
  });
});
