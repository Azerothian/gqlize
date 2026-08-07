import { isAllowed, isModelAllowed } from "@azerothian/utilize";
import type { Permission } from "@azerothian/utilize";
import { TemporalizeRegistry } from "./registry";
import type { SchemaSet } from "./registry";
import type { ActivityMap, TemporalizeOptions } from "./types";
import { listModels } from "./queue";
import {
  activityName,
  classMethodActivityName,
  instanceMethodActivityName,
  ErrorType,
  MUTATION_KIND,
} from "./workflow-types";
import {
  assertFilterAllowed,
  assertMutationAllowed,
  assertOrderAllowed,
  assertPagination,
  assertScopedMutation,
  assertWritable,
  fail,
  present,
  requireContext,
  toPlain,
  validateInput,
} from "./guards";

/** Per-call state shared by every handler: the caller's context and its gates. */
type Call = {
  context: any;
  permission?: Permission;
  schemas: SchemaSet;
};

/** Method names declared either top-level or under `options` (the adapter merges both, `options` winning). */
function methodNames(definition: any, key: "classMethods" | "instanceMethods"): string[] {
  const source = (definition && definition.options && definition.options[key]) || (definition && definition[key]);
  if (!source) {
    return [];
  }
  return Object.keys(source).filter((name) => typeof source[name] === "function");
}

/**
 * Generate the Temporal activity implementations for an initialised ormize
 * instance. Keys are the activity names the workflow half builds via
 * `activityName`/`classMethodActivityName`/`instanceMethodActivityName`, e.g.
 * `"Task.create"`, `"Task.classMethods.reverseName"`.
 *
 * `models` narrows the output to a single queue's models; omit it for all of them.
 */
export function createActivities(
  orm: any,
  options: TemporalizeOptions = {},
  models?: string[],
  registry: TemporalizeRegistry = new TemporalizeRegistry(orm, options)
): ActivityMap {
  const validate = options.validate !== false;
  const transactional = options.transactional !== false;
  const exposeClass = options.expose?.classMethods !== false;
  const exposeInstance = options.expose?.instanceMethods !== false;
  const names = models ? models.slice() : listModels(orm, options);

  /**
   * Resolve the per-call gates, then run `fn` with the caller's context installed
   * as ormize's ambient context (so `definition.before`/`after` hooks and model
   * hooks can read it via `orm.getContext()`). The same object is handed to the
   * engine as its `context` argument, so it also reaches hooks through
   * `options.getGraphQLArgs()`.
   */
  const invoke = async (name: string, req: any, mutating: boolean, fn: (call: Call) => Promise<any>) => {
    const context = requireContext(req);
    const permission = options.resolvePermission ? await options.resolvePermission(context) : undefined;
    if (!isModelAllowed(permission, name)) {
      fail(ErrorType.UnknownModel, `temporalize: unknown or not permitted model '${name}'`);
    }
    const call: Call = { context, permission, schemas: registry.schemas(permission) };
    const body = () => fn(call);
    return orm.runWithContext(context, () => {
      // Mutating activities may issue several engine calls (load-then-mutate for
      // instance methods); one coordinator makes them commit or roll back together.
      return mutating && transactional ? orm.transaction(body) : body();
    });
  };

  /** Public `{ limit, offset }` -> the engine's cursor arg shape (`first` / `after.index`). */
  const listArgs = (name: string, call: Call, req: any) => {
    assertPagination(req.limit, req.offset);
    assertFilterAllowed(call.permission, name, req.where);
    assertOrderAllowed(call.permission, name, req.orderBy);
    const args: any = {};
    if (req.where !== undefined) {
      args.where = req.where;
    }
    if (req.orderBy) {
      args.orderBy = req.orderBy;
    }
    if (req.limit !== undefined) {
      args.first = req.limit;
    }
    if (req.offset) {
      args.after = { index: req.offset - 1 };
    }
    return args;
  };

  const pkName = (name: string): string => {
    const keys = orm.getModelAdapter(name).getPrimaryKeyNameForModel(name);
    return (keys && keys[0]) || "id";
  };

  const loadInstance = async (name: string, call: Call, id: any) => {
    if (id === undefined || id === null) {
      fail(ErrorType.Validation, `temporalize: 'id' is required to address a ${name} instance`);
    }
    const args = { where: { [pkName(name)]: { eq: id } }, first: 1 };
    const { models: found } = await orm.resolveFindAll(name, null, args, call.context);
    if (!found || found.length === 0) {
      fail(ErrorType.NotFound, `temporalize: ${name} '${id}' not found`);
    }
    return found[0];
  };

  const assertMutable = (call: Call, name: string, op: string) => {
    assertWritable(options.readOnly);
    assertMutationAllowed(call.permission, name, MUTATION_KIND[op]);
  };

  // Plain object: keys are derived from model definitions (never from caller
  // input), and the Temporal worker enumerates this map with normal Object methods.
  const activities: ActivityMap = {};

  for (const name of names) {
    const definition = orm.getDefinition(name);
    if (!definition) {
      throw new Error(`temporalize: unknown model '${name}'`);
    }

    // --- reads ---------------------------------------------------------------

    activities[activityName(name, "findAll")] = (req: any) =>
      invoke(name, req, false, async (call) => {
        const { total, models: rows } = await orm.resolveFindAll(name, null, listArgs(name, call, req), call.context);
        return { total, rows: present(call.schemas, name, rows) };
      });

    activities[activityName(name, "findOne")] = (req: any) =>
      invoke(name, req, false, async (call) => {
        const args = Object.assign(listArgs(name, call, req), { first: 1 });
        const { models: rows } = await orm.resolveFindAll(name, null, args, call.context);
        return rows && rows.length ? present(call.schemas, name, rows[0]) : null;
      });

    activities[activityName(name, "findByPk")] = (req: any) =>
      invoke(name, req, false, async (call) => {
        const args = { where: { [pkName(name)]: { eq: req.id } }, first: 1 };
        const { models: rows } = await orm.resolveFindAll(name, null, args, call.context);
        return rows && rows.length ? present(call.schemas, name, rows[0]) : null;
      });

    activities[activityName(name, "count")] = (req: any) =>
      invoke(name, req, false, async (call) => {
        const { total } = await orm.resolveFindAll(name, null, listArgs(name, call, req), call.context, {
          countOnly: true,
        });
        return total;
      });

    // --- writes --------------------------------------------------------------

    activities[activityName(name, "create")] = (req: any) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "create");
        const input = validate ? validateInput(call.schemas, name, "create", req.input) : req.input;
        const rows = await orm.processCreate(name, null, { input }, call.context);
        return present(call.schemas, name, rows);
      });

    activities[activityName(name, "update")] = (req: any) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "update");
        assertScopedMutation(req.where, req.all);
        assertFilterAllowed(call.permission, name, req.where);
        assertPagination(req.limit, undefined);
        const input = validate ? validateInput(call.schemas, name, "update", req.input) : req.input;
        const rows = await orm.processUpdate(name, null, { input, where: req.where || {}, limit: req.limit }, call.context);
        return present(call.schemas, name, rows);
      });

    activities[activityName(name, "destroy")] = (req: any) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "destroy");
        assertScopedMutation(req.where, req.all);
        assertFilterAllowed(call.permission, name, req.where);
        const rows = await orm.processDelete(name, null, req.where || {}, call.context);
        return present(call.schemas, name, rows);
      });

    // `select` matches rows by `where` then applies relationship verbs from
    // `input` against each match. Scalar `input` fields are ignored and the
    // matched rows are never written — but it is still a mutation, so it is gated
    // and scoped exactly like `update`.
    activities[activityName(name, "select")] = (req: any) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "select");
        assertScopedMutation(req.where, req.all);
        assertFilterAllowed(call.permission, name, req.where);
        assertPagination(req.limit, undefined);
        const rows = await orm.processSelect(
          name,
          null,
          { input: req.input, where: req.where || {}, limit: req.limit },
          call.context
        );
        return present(call.schemas, name, rows);
      });

    // --- class / instance methods -------------------------------------------

    if (exposeClass) {
      for (const method of methodNames(definition, "classMethods")) {
        activities[classMethodActivityName(name, method)] = (req: any) =>
          invoke(name, req, true, async (call) => {
            assertWritable(options.readOnly);
            const gate = (call.permission as any)?.mutationClassMethods;
            if (!isAllowed(gate, name, method, (call.permission as any)?.options)) {
              fail(ErrorType.Forbidden, `temporalize: class method '${method}' not allowed for ${name}`);
            }
            return toPlain(await orm.resolveClassMethod(name, method, req.args, call.context));
          });
      }
    }

    if (exposeInstance) {
      for (const method of methodNames(definition, "instanceMethods")) {
        activities[instanceMethodActivityName(name, method)] = (req: any) =>
          invoke(name, req, true, async (call) => {
            assertWritable(options.readOnly);
            const gate = (call.permission as any)?.queryInstanceMethods;
            if (!isAllowed(gate, name, method, (call.permission as any)?.options)) {
              fail(ErrorType.Forbidden, `temporalize: instance method '${method}' not allowed for ${name}`);
            }
            const row = await loadInstance(name, call, req.id);
            if (typeof row[method] !== "function") {
              fail(ErrorType.UnknownMethod, `temporalize: unknown method '${method}' on ${name}`);
            }
            return toPlain(await row[method](req.args, call.context));
          });
      }
    }
  }

  return activities;
}
