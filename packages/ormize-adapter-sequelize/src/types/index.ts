import { Definition, DefinitionOptions } from '@azerothian/utilize/types/index';
export interface SequelizeDefinitionOptions extends DefinitionOptions {
  tableName?: string;
}

/** One DDL entry registered under {@link SequelizeDefinition.queries}, replayed by `initialise`/`reset`. */
export type SequelizeStartupQuery = {
  drop?: string | (() => string);
  create?: string | (() => string);
};

export interface SequelizeDefinition extends Definition {
  tableName?: string;
  disablePrimaryKey?: boolean;
  /**
   * Columns to drop off the model after it is defined — `removeAttribute` takes
   * a column name, so this is the list of names. Chiefly for shedding an
   * inherited default attribute a particular model should not have.
   */
  removeAttributes?: string[];

  // `instanceMethods` is inherited from `Definition` unchanged — Sequelize
  // installs whatever is authored there directly onto the model prototype
  // without narrowing it, so there is nothing Sequelize-specific to restate.
  /** Raw create/drop DDL, replayed by {@link SequelizeAdapter.initialise} and `reset`. Sequelize-only; `Definition` has no equivalent. */
  queries?: { [name: string]: SequelizeStartupQuery };
  options?: SequelizeDefinitionOptions
}

/**
 * A `classMethods` entry naming a raw query or Postgres function call rather
 * than a function — narrowed out of the function-typed `classMethods` bag at
 * the one branch that installs it (see `installClassMethods`).
 */
export interface SqlClassMethod {
  type?: "query" | "sqlfunction";
  schema?: string;
  functionName?: string;
  query?: string;
  modelName?: string;
  args?: string[];
}
