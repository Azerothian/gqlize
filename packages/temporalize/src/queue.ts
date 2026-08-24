import type { Ormize } from "@azerothian/ormize";
import type { QueueMap, TemporalizeOptions } from "./types";

/** Definitions the options allow us to generate for, in registration order. */
export function listModels(orm: Ormize, options: TemporalizeOptions = {}): string[] {
  const defs = orm.getDefinitions() || {};
  const names = Object.keys(defs);
  if (!options.models) {
    return names;
  }
  const allowed = new Set(options.models);
  return names.filter((name) => allowed.has(name));
}

/**
 * Task queue for a model: `prefix + datasource + model`, joined by
 * `queueSeparator` (default `"."`) — e.g. `myapp.sqlite.Task`. A `queues` entry
 * wins outright; otherwise a `queueName` callback wins; otherwise the segments
 * are composed.
 */
export function resolveQueueName(orm: Ormize, model: string, options: TemporalizeOptions = {}): string {
  const override = options.queues && options.queues[model];
  if (override) {
    return override;
  }
  const definition = orm.getDefinition(model);
  if (!definition) {
    throw new Error(`temporalize: unknown model '${model}'`);
  }
  const datasource = orm.defsAdapters[model] || definition.datasource || "";
  if (options.queueName) {
    return options.queueName({ model, datasource, definition });
  }
  const separator = options.queueSeparator ?? ".";
  const includeDatasource = options.includeDatasource !== false;
  return [options.queuePrefix, includeDatasource ? datasource : undefined, model]
    .filter((segment) => Boolean(segment))
    .join(separator);
}

/**
 * Both directions of the model <-> queue mapping. `byQueue` is what the worker
 * factory iterates: a `queues` override can legitimately land several models on
 * one queue, and that worker must register all of their activities.
 */
export function buildQueueMap(orm: Ormize, options: TemporalizeOptions = {}): QueueMap {
  const byModel: { [model: string]: string } = {};
  const byQueue: { [queue: string]: string[] } = {};
  for (const model of listModels(orm, options)) {
    const queue = resolveQueueName(orm, model, options);
    byModel[model] = queue;
    (byQueue[queue] = byQueue[queue] || []).push(model);
  }
  return { byModel, byQueue };
}
