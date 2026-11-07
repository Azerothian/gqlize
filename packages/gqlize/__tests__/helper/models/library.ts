import Sequelize from "sequelize";
import type {Definition} from "../../../src/types/index";

/**
 * Author hasMany Book, Book belongsToMany Tag through an implicit `BookTags`
 * join table: one of each relationship kind, plus a DATE column, for the read
 * cache suites and benchmark (`read-cache.test.ts`, `bench/read-cache.bench.ts`).
 */
export const AuthorModel: Definition = {
  name: "Author",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
    bio: {type: Sequelize.TEXT, allowNull: true},
  },
  relationships: [
    {type: "hasMany", model: "Book", name: "books", options: {foreignKey: "authorId"}},
  ],
};

export const BookModel: Definition = {
  name: "Book",
  define: {
    title: {type: Sequelize.STRING, allowNull: false},
    publishedAt: {type: Sequelize.DATE, allowNull: true},
  },
  relationships: [
    {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
    {type: "belongsToMany", model: "Tag", name: "tags", options: {through: "BookTags", foreignKey: "bookId", otherKey: "tagId"}},
  ],
};

export const TagModel: Definition = {
  name: "Tag",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
  },
  relationships: [
    {type: "belongsToMany", model: "Book", name: "books", options: {through: "BookTags", foreignKey: "tagId", otherKey: "bookId"}},
  ],
};

export const LIBRARY = [AuthorModel, BookModel, TagModel];
