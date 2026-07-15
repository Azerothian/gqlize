// Compile-time assertions for the definition typesystem. This file emits no
// runtime output of interest; it passes iff it type-checks (see tsconfig.test-d.json).
/* eslint-disable @typescript-eslint/no-unused-vars */
import Sequelize, {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from "sequelize";
import { defineModel, SequelizeModel } from "../../src/types/orm";

// --- Author-declared instance interfaces (Sequelize v6 idiom) ---------------
interface TaskV1Instance
  extends Model<InferAttributes<TaskV1Instance>, InferCreationAttributes<TaskV1Instance>> {
  id: CreationOptional<string>;
  name: string;
}
interface TaskV1Statics {
  staticMethod1(args: string, context: any): Promise<any>;
}
const TaskV1 = defineModel<TaskV1Instance, TaskV1Statics>({
  name: "Task",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  classMethods: {
    async staticMethod1(_args, _context) {
      return {};
    },
  },
});

interface TaskV2Instance
  extends Model<InferAttributes<TaskV2Instance>, InferCreationAttributes<TaskV2Instance>> {
  author: string;
}
interface TaskV2Statics {
  staticMethod2(args: string, context: any): string;
}
const TaskV2 = defineModel<TaskV2Instance, TaskV2Statics>({
  name: "Task",
  define: { author: { type: Sequelize.STRING, allowNull: false } },
  classMethods: {
    staticMethod2(_args, _context) {
      return "";
    },
  },
});

// Compose: TaskV1 required, TaskV2 optional (the brief's example).
type TaskModel = SequelizeModel<[typeof TaskV1], [typeof TaskV2]>;

declare const Task: TaskModel;

async function positiveAssertions() {
  // create() typed by Sequelize CreationAttributes of the required fragment
  const created = await Task.create({ name: "x" });
  const name: string = created.name; // required attr
  const author: string | undefined = created.author; // optional-bucket attr

  // findOne/findAll come from Sequelize's ModelStatic
  const one = await Task.findOne();
  if (one) {
    const n: string = one.name;
  }
  const all = await Task.findAll();
  const first: string = all[0].name;

  // statics: required vs optional
  await Task.staticMethod1("a", {});
  Task.staticMethod2?.("a", {});
}

async function negativeAssertions() {
  // @ts-expect-error — `name` is required by CreationAttributes
  await Task.create({});

  // @ts-expect-error — staticMethod1 expects a string first argument
  await Task.staticMethod1(123, {});

  // @ts-expect-error — staticMethod2 is optional (possibly undefined), needs ?.
  Task.staticMethod2("a", {});

  const created = await Task.create({ name: "x" });
  // @ts-expect-error — `nope` is not an attribute
  const bad: string = created.nope;
}

// Reference the functions so they aren't flagged as entirely unused.
export const __typecheck = [positiveAssertions, negativeAssertions];
