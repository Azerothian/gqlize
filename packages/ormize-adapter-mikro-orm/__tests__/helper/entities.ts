// Test entities, declared with `EntitySchema` rather than decorators.
//
// Decorators moved to `@mikro-orm/decorators/legacy` in MikroORM v7 and need
// `experimentalDecorators`, which this repo does not enable. `EntitySchema` is
// the supported declaration form in both v6 and v7 and needs no compiler flag,
// so the suites use it throughout — the adapter reads discovered metadata and
// cannot tell the two apart anyway.

import { EntitySchema, Collection, type Ref } from "@mikro-orm/core";

export class Author {
  id!: number;
  name!: string;
  email?: string;
  rank!: number;
  active!: boolean;
  createdAt!: Date;
  articles = new Collection<Article>(this);
}

export class Article {
  id!: number;
  title!: string;
  body?: string;
  status!: "draft" | "in-progress" | "2xl";
  views!: number;
  deletedAt?: Date | null;
  author!: Ref<Author>;
  /** Declared without `ref: true` on purpose — see the note on the schema. */
  editor?: Author;
  tags = new Collection<Tag>(this);
}

export class Tag {
  id!: number;
  label!: string;
  articles = new Collection<Article>(this);
}

export const AuthorSchema = new EntitySchema<Author>({
  class: Author,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    email: { type: "string", nullable: true, unique: true },
    rank: { type: "number", default: 0 },
    active: { type: "boolean", default: true },
    createdAt: { type: "Date", onCreate: () => new Date() },
    articles: { kind: "1:m", entity: () => Article, mappedBy: "author" },
  },
});

export const ArticleSchema = new EntitySchema<Article>({
  class: Article,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    title: { type: "string", comment: "Headline" },
    body: { type: "string", nullable: true },
    status: { enum: true, items: ["draft", "in-progress", "2xl"] },
    views: { type: "number", default: 0 },
    deletedAt: { type: "Date", nullable: true },
    author: { kind: "m:1", entity: () => Author, ref: true, inversedBy: "articles" },
    // Deliberately *not* `ref: true`. The property then holds the entity itself
    // rather than a `Reference`, and an uninitialised one is indistinguishable
    // from a loaded row with everything but the key missing — which is why the
    // adapter populates rather than testing whether it needs to.
    editor: { kind: "m:1", entity: () => Author, nullable: true },
    tags: { kind: "m:n", entity: () => Tag, inversedBy: "articles" },
  },
});

export const TagSchema = new EntitySchema<Tag>({
  class: Tag,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    label: { type: "string" },
    articles: { kind: "m:n", entity: () => Article, mappedBy: "tags" },
  },
});

export const schemas = [AuthorSchema, ArticleSchema, TagSchema];
