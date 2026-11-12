import { EntitySchema, Collection, type Ref } from "@mikro-orm/core";

/**
 * Ordinary MikroORM entities. Nothing here knows about ormize or GraphQL — that
 * is the point: the adapter reads them out of MikroORM's own metadata.
 *
 * Declared with `EntitySchema` rather than decorators so the example needs no
 * `experimentalDecorators`; decorators work exactly the same way.
 */

export class Item {
  id!: number;
  label!: string;
  tasks = new Collection<Task>(this);
}

export class Task {
  id!: number;
  name!: string;
  done!: boolean;
  createdAt!: Date;
  item!: Ref<Item>;
}

export const ItemSchema = new EntitySchema<Item>({
  class: Item,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    label: { type: "string", comment: "What this group of tasks is called" },
    tasks: { kind: "1:m", entity: () => Task, mappedBy: "item" },
  },
});

export const TaskSchema = new EntitySchema<Task>({
  class: Task,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    done: { type: "boolean", default: false },
    createdAt: { type: "Date", onCreate: () => new Date() },
    item: { kind: "m:1", entity: () => Item, ref: true, inversedBy: "tasks" },
  },
});

export const entities = [ItemSchema, TaskSchema];

/** The entity map that types `orm.models.*`. See the adapter README. */
export type Entities = { Item: Item; Task: Task };
