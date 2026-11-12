// Type-level assertions for the definition typesystem binding.
//
// Run under `tsconfig.test-d.json`, which compiles only the pure-type modules
// and these files — so the assertions are checked under `strict` regardless of
// how the runtime source is configured. Nothing here executes.

import { Ormize } from "@azerothian/ormize";
import MikroAdapter from "../../src/index";
import type { MikroModel, MikroModelStatics } from "../../src/model";

declare class Author {
  id: number;
  name: string;
  greet(): string;
}
declare class Article {
  id: number;
  title: string;
}

declare const mikro: import("../../src/types/index").MikroORMInstance;

const db = new Ormize().registerAdapter(new MikroAdapter<{ Author: Author; Article: Article }>(mikro));

// `registerAdapter` folds the adapter's entity map into `TModels`, so a model is
// typed without any `define()` call ever being made.
const author: MikroModel<Author> & MikroModelStatics<Author> = db.models.Author;
const article: MikroModel<Article> & MikroModelStatics<Article> = db.models.Article;

// The statics are typed by the entity, not by `unknown`.
const found: Promise<Author[]> = author.findAll();
const one: Promise<Author | null> = author.findByPk(1);
const created: Promise<Author> = author.create({ name: "Ada" });
const total: Promise<number> = article.count();

// And the metadata the adapter carries is reachable off the handle.
const primaryKey: string = author.primaryKey;
const aliases: { [fieldName: string]: string } = author.aliases;

// The entity map distinguishes the models: one entity's handle is not the
// other's, which is the whole point of threading `TEntities` through.
// @ts-expect-error - an Article handle is not an Author handle
const wrong: MikroModel<Author> & MikroModelStatics<Author> = db.models.Article;

// And a row is typed by the entity it came from.
// @ts-expect-error - `Author` has no `title`
const noSuchField: Promise<string> = author.findByPk(1).then((row) => row!.title);

// A method the entity declares is reachable on a row.
const greeting: Promise<string | undefined> = author.findOne().then((row) => row?.greet());

// Note what is deliberately *not* asserted: `db.models.Usr` is not a compile
// error, and neither is `author.findAl()`. `Ormize`'s default `TModels` carries
// a string index signature and the ormize `Model` contract is an open bag for
// user-declared class methods — both by design, and both outside this adapter.
// An adapter given no entity map contributes nothing rather than breaking that.
const bare = new Ormize().registerAdapter(new MikroAdapter(mikro));

export { author, article, found, one, created, total, primaryKey, aliases, bare, wrong, noSuchField, greeting };
