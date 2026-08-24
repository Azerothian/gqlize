import { Definition, DefinitionOptions } from '@azerothian/utilize/types/index';
export interface SequelizeDefinitionOptions extends DefinitionOptions {
  tableName?: string;
}
export interface SequelizeDefinition extends Definition {
  tableName?: string;
  disablePrimaryKey?: boolean;
  /**
   * Columns to drop off the model after it is defined — `removeAttribute` takes
   * a column name, so this is the list of names. Chiefly for shedding an
   * inherited default attribute a particular model should not have.
   */
  removeAttributes?: string[];

  // classMethods?: {
  //   [key: string]: any;// SqlClassMethod | ((args: any, context: any) => any);
  // };
  instanceMethods?: {
    [key: string]: (this: any, args: any, context: any) => any;
  };
  queries?: any;
  options?: SequelizeDefinitionOptions
}

export interface SqlClassMethod {
  type?: string | undefined;
  schema?: string | undefined;
  functionName?: any;
  query?: any;
  modelName?: any;
  args?: any[] | undefined;
}