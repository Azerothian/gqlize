import { isAllowed, isModelAllowed } from "@azerothian/utilize";
import { mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
import type { Definition, Permission, PermissionContext } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import { TemporalizeRegistry } from "./registry";
import type { SchemaSet } from "./registry";
import type { ActivityMap, TemporalizeOptions } from "./types";
import { listModels } from "./queue";
import type {
  ActivityRequest,
  ByPkArgs,
  CreateArgs,
  DestroyArgs,
  FindArgs,
  InstanceMethodArgs,
  MethodArgs,
  OrderEntry,
  PlainRow,
  PrimaryKeyValue,
  SelectArgs,
  UpdateArgs,
  WhereClause,
} from "./workflow-types";
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
  context: PermissionContext;
  permission?: Permission;
  schemas: SchemaSet;
};

/** Method names declared either top-level or under `options` (the adapter merges both, `options` winning). */
function methodNames(definition: Definition, key: "classMethods" | "instanceMethods"): string[] {
  const source = definition.options?.[key] || definition[key];
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
  orm: Ormize,
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
  const invoke = async (name: string, req: unknown, mutating: boolean, fn: (call: Call) => Promise<unknown>) => {
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
  const listArgs = (name: string, call: Call, req: FindArgs) => {
    assertPagination(req.limit, req.offset);
    assertFilterAllowed(call.permission, name, req.where);
    assertOrderAllowed(call.permission, name, req.orderBy);
    // The engine's cursor shape, not the public one: `first`/`after.index` rather
    // than `limit`/`offset`.
    const args: {
      where?: WhereClause;
      orderBy?: OrderEntry[];
      first?: number;
      after?: { index: number };
    } = {};
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

  const requireId = (name: string, id: PrimaryKeyValue | undefined): PrimaryKeyValue => {
    if (id === undefined || id === null) {
      fail(ErrorType.Validation, `temporalize: 'id' is required to address a ${name} instance`);
    }
    return id;
  };

  const loadInstance = async (name: string, call: Call, id: PrimaryKeyValue | undefined): Promise<PlainRow> => {
    const args = { where: { [pkName(name)]: { eq: requireId(name, id) } }, first: 1 };
    const { models: found } = await orm.resolveFindAll(name, null, args, call.context);
    if (!found || found.length === 0) {
      fail(ErrorType.NotFound, `temporalize: ${name} '${id}' not found`);
    }
    // An adapter row is opaque by contract, so the engine hands it back as
    // `unknown`. The only thing read off it here is a method looked up by name.
    return found[0] as PlainRow;
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

    activities[activityName(name, "findAll")] = (req: ActivityRequest<FindArgs>) =>
      invoke(name, req, false, async (call) => {
        const { total, models: rows } = await orm.resolveFindAll(name, null, listArgs(name, call, req), call.context);
        return { total, rows: present(call.schemas, name, rows) };
      });

    activities[activityName(name, "findOne")] = (req: ActivityRequest<FindArgs>) =>
      invoke(name, req, false, async (call) => {
        const args = Object.assign(listArgs(name, call, req), { first: 1 });
        const { models: rows } = await orm.resolveFindAll(name, null, args, call.context);
        return rows && rows.length ? present(call.schemas, name, rows[0]) : null;
      });

    activities[activityName(name, "findByPk")] = (req: ActivityRequest<ByPkArgs>) =>
      invoke(name, req, false, async (call) => {
        const args = { where: { [pkName(name)]: { eq: req.id } }, first: 1 };
        const { models: rows } = await orm.resolveFindAll(name, null, args, call.context);
        return rows && rows.length ? present(call.schemas, name, rows[0]) : null;
      });

    activities[activityName(name, "count")] = (req: ActivityRequest<FindArgs>) =>
      invoke(name, req, false, async (call) => {
        const { total } = await orm.resolveFindAll(name, null, listArgs(name, call, req), call.context, {
          countOnly: true,
        });
        return total;
      });

    // --- writes --------------------------------------------------------------

    activities[activityName(name, "create")] = (req: ActivityRequest<CreateArgs>) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "create");
        const input = validate ? validateInput(call.schemas, name, "create", req.input) : req.input;
        const rows = await orm.processCreate(name, null, { input }, call.context);
        return present(call.schemas, name, rows);
      });

    activities[activityName(name, "update")] = (req: ActivityRequest<UpdateArgs>) =>
      invoke(name, req, true, async (call) => {
        assertMutable(call, name, "update");
        assertScopedMutation(req.where, req.all);
        assertFilterAllowed(call.permission, name, req.where);
        assertPagination(req.limit, undefined);
        const input = validate ? validateInput(call.schemas, name, "update", req.input) : req.input;
        const rows = await orm.processUpdate(name, null, { input, where: req.where || {}, limit: req.limit }, call.context);
        return present(call.schemas, name, rows);
      });

    activities[activityName(name, "destroy")] = (req: ActivityRequest<DestroyArgs>) =>
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
    activities[activityName(name, "select")] = (req: ActivityRequest<SelectArgs>) =>
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
        activities[classMethodActivityName(name, method)] = (req: ActivityRequest<MethodArgs>) =>
          invoke(name, req, true, async (call) => {
            assertWritable(options.readOnly);
            if (!isAllowed(call.permission?.mutationClassMethods, name, method, call.permission?.options)) {
              fail(ErrorType.Forbidden, `temporalize: class method '${method}' not allowed for ${name}`);
            }
            return toPlain(await orm.resolveClassMethod(name, method, req.args, call.context));
          });
      }
    }

    if (exposeInstance) {
      // Activities are enumerated from the *implementation* map, which is one
      // namespace shared by both `expose.instanceMethods` targets. Which target
      // declared a method is the only thing that says whether it reads or
      // writes.
      //
      // A name under both targets is a definition error, and gqlize refuses to
      // build a schema containing one — but `assertNoExposedMethodCollisions`
      // runs from `create-model-type.ts` alone, so a temporalize-only consumer
      // never reaches it. Here the mutation lane simply wins, deterministically:
      // the stricter of the two gates, which is the right way for an unrefused
      // ambiguity to land.
      //
      // A method declared under neither — the common case, since `expose` is
      // optional — keeps the read-only treatment it has always had.
      const transforms = mutationInstanceMethods(definition);
      for (const method of methodNames(definition, "instanceMethods")) {
        const isTransform = !!transforms[method];
        activities[instanceMethodActivityName(name, method)] = (req: ActivityRequest<InstanceMethodArgs>) =>
          invoke(name, req, true, async (call) => {
            const gate = isTransform
              ? call.permission?.mutationInstanceMethods
              : call.permission?.queryInstanceMethods;
            if (!isAllowed(gate, name, method, call.permission?.options)) {
              fail(ErrorType.Forbidden, `temporalize: instance method '${method}' not allowed for ${name}`);
            }
            if (isTransform) {
              // A transform is a write, so it answers to the same read-only flag
              // and model-level update gate every CRUD write activity checks.
              // `mutationInstanceMethods` says which transforms a role may run;
              // it does not say the role may write at all.
              assertMutable(call, name, "update");
              // A transform reshapes a row on its way to a write. Loading the
              // row and calling the method — which is what this activity used to
              // do — drops everything it assigns to `this`, and left the
              // surrounding transaction holding nothing but the read. Routing it
              // through the same `processUpdate`/`apply` path gqlize's `apply`
              // argument takes brings the persist, the proxy that records those
              // writes, and scope enforcement with it.
              //
              // Invoking the activity is itself the ask, so absent args mean
              // "run it with no params". gqlize's "named but not asked for"
              // reading of a falsy value only exists because its `apply` input
              // lists every exposed transform at once; an activity names one.
              const params = req.args === undefined || req.args === null || req.args === false ? true : req.args;
              const rows = await orm.processUpdate(name, null, {
                input: {},
                where: { [pkName(name)]: { eq: requireId(name, req.id) } },
                limit: 1,
                apply: { [method]: params },
              }, call.context);
              if (!rows || rows.length === 0) {
                fail(ErrorType.NotFound, `temporalize: ${name} '${req.id}' not found`);
              }
              // `req.id` names one row, so the activity answers with that row —
              // the same shape `findByPk` returns, rather than the list
              // `processUpdate` hands back.
              return present(call.schemas, name, rows[0]);
            }
            const row = await loadInstance(name, call, req.id);
            // The loaded row is an adapter instance, so its methods are not
            // visible on the plain-row type the engine's return is described by.
            const instanceMethod = row[method];
            if (typeof instanceMethod !== "function") {
              fail(ErrorType.UnknownMethod, `temporalize: unknown method '${method}' on ${name}`);
            }
            return toPlain(await instanceMethod.call(row, req.args, call.context));
          });
      }
    }
  }

  return activities;
}
