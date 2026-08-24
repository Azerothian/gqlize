/*

The MIT License (MIT)

Copyright (c) 2015 Mick Hansen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import Sequelize from "sequelize";
import {
  GraphQLInt,
  GraphQLString,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLEnumType,
  GraphQLList,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import type { NativeDataType } from "@azerothian/utilize/types/index";

import jsonType from "@azerothian/graphql-types/json";
import dateType from "@azerothian/graphql-types/date";
import uploadType from "@azerothian/graphql-types/upload";

import {capitalize} from "@azerothian/utilize/utils/word";

/**
 * The mapper `SequelizeAdapter.getTypeMapper` hands back. Returns a type that is
 * valid in both variances — a scalar, an enum, or a list of one — because the
 * same mapper builds output fields and `where` input fields alike.
 */
export default function typeMapper(
  type: NativeDataType,
  modelName: string,
  fieldName: string,
): GraphQLInputType & GraphQLOutputType {
  return toGraphQL(type, Sequelize, modelName, fieldName);
}

/**
 * Checks the type of the sequelize data type and
 * returns the corresponding type in GraphQL.
 *
 * `sequelizeTypes` is the DataTypes namespace to discriminate against — passed in
 * rather than imported so a caller can supply a dialect-specific one — and it is
 * read purely as a bag of constructors to `instanceof` against, which is what
 * {@link SequelizeDataTypeNamespace} names.
 */
export function toGraphQL(
  sequelizeType: NativeDataType,
  sequelizeTypes: SequelizeDataTypeNamespace,
  modelName?: string,
  fieldName?: string,
): GraphQLInputType & GraphQLOutputType {
  const {
    BOOLEAN,
    ENUM,
    FLOAT,
    REAL,
    CHAR,
    DECIMAL,
    DOUBLE,
    INTEGER,
    BIGINT,
    STRING,
    TEXT,
    UUID,
    DATE,
    DATEONLY,
    TIME,
    ARRAY,
    VIRTUAL,
    JSON,
    JSONB,
    GEOMETRY,
    UUIDV4,
    BLOB,
    MACADDR,
    CIDR,
    INET,
  } = sequelizeTypes;

  // Map of special characters
  const specialCharsMap = new Map([
    ["¼", "frac14"],
    ["½", "frac12"],
    ["¾", "frac34"],
  ]);

  if (sequelizeType instanceof BOOLEAN) {
    return GraphQLBoolean;
  }

  if (sequelizeType instanceof FLOAT ||
    sequelizeType instanceof REAL ||
    sequelizeType instanceof DOUBLE
  ) {
    return GraphQLFloat;
  }

  if (sequelizeType instanceof DATE) {
    return dateType;
  }

  if (
    sequelizeType instanceof CHAR ||
    sequelizeType instanceof STRING ||
    sequelizeType instanceof TEXT ||
    sequelizeType instanceof UUID ||
    sequelizeType instanceof UUIDV4 ||
    sequelizeType instanceof DATEONLY ||
    sequelizeType instanceof TIME ||
    sequelizeType instanceof BIGINT ||
    sequelizeType instanceof DECIMAL ||
    sequelizeType instanceof MACADDR ||
    sequelizeType instanceof CIDR ||
    sequelizeType instanceof INET
  ) {
    return GraphQLString;
  }

  if (sequelizeType instanceof INTEGER) {
    return GraphQLInt;
  }

  if (sequelizeType instanceof ARRAY) {
    const elementType = toGraphQL(sequelizeType.type, sequelizeTypes, modelName, fieldName);
    return new GraphQLList(elementType);
  }

  if (sequelizeType instanceof ENUM) {
    const values = (sequelizeType.values || []).reduce((o: { [name: string]: { value: string } }, k: string) => {
      o[sanitizeEnumValue(k)] = {
        value: k,
      };
      return o;
    }, {});
    return new GraphQLEnumType({
      name: `${capitalize(modelName)}${capitalize(fieldName)}Enum`,
      values,
    });
  }

  if (sequelizeType instanceof VIRTUAL) {
    const returnType = sequelizeType.returnType
      ? toGraphQL(sequelizeType.returnType, sequelizeTypes)
      : GraphQLString;
    return returnType;
  }

  if (sequelizeType instanceof JSONB || sequelizeType instanceof JSON || sequelizeType instanceof GEOMETRY) {
    return jsonType;
  }
  if (sequelizeType instanceof BLOB) {
    return uploadType;
  }
  // Nothing matched, so no `instanceof` narrowed it — but a live Sequelize type
  // always carries one of these two, and naming the type is the whole point of
  // the message.
  const unmatched = sequelizeType as Partial<NarrowedNativeType>;
  throw new Error(
    `Unable to convert ${unmatched?.key ||
      unmatched?.toSql?.()} to a GraphQL type`
  );

  function sanitizeEnumValue(value: string) {
    return value
      .trim()
      .replace(/([^_a-zA-Z0-9])/g, (_: string, p: string) => specialCharsMap.get(p) || " ")
      .split(" ")
      .map((v: string, i: number) => (i ? capitalize(v) : v))
      .join("")
      .replace(/(^\d)/, "_$1");
  }
}

/**
 * The Sequelize DataTypes namespace, seen as what this module actually uses it
 * for: a bag of constructors to `instanceof` a live type against. Sequelize's own
 * typings give each member a distinct constructor signature, which `instanceof`
 * does not need and which would make the destructuring above a list of twenty-six
 * separate narrowings for no gain.
 */
export type SequelizeDataTypeNamespace = {
  [K in SequelizeTypeName]: abstract new (...args: never[]) => NarrowedNativeType;
};

/** The DataTypes this module discriminates against — exactly what it destructures. */
type SequelizeTypeName =
  | "BOOLEAN" | "ENUM" | "FLOAT" | "REAL" | "CHAR" | "DECIMAL" | "DOUBLE"
  | "INTEGER" | "BIGINT" | "STRING" | "TEXT" | "UUID" | "DATE" | "DATEONLY"
  | "TIME" | "ARRAY" | "VIRTUAL" | "JSON" | "JSONB" | "GEOMETRY" | "UUIDV4"
  | "BLOB" | "MACADDR" | "CIDR" | "INET";

/** What `instanceof` leaves behind: the members this module reads off a live type. */
interface NarrowedNativeType {
  /** ARRAY's element type. */
  type?: NativeDataType;
  /** ENUM's declared members. */
  values?: string[];
  /** VIRTUAL's declared return type. */
  returnType?: NativeDataType;
  key?: string;
  toSql(): string;
}
