// utilize's filter-operator allow-list (`filter-operators.ts`) restates the
// operator vocabulary graphql-types builds gqlize's filter types from, because
// utilize cannot import it. This pins the two together: an operator added to
// one and not the other would be offered by GraphQL and refused over REST, or
// the other way round.
import {describe, it, expect} from "@jest/globals";
import {CORE_VALUE_FUNCS, REGEX_VALUE_FUNCS, SQL_ARRAY_VALUES} from "@azerothian/graphql-types/operators";
import {FILTER_LIST_OPERATORS, FILTER_REGEX_OPERATORS, FILTER_VALUE_OPERATORS} from "@azerothian/utilize/filter-operators";

describe("filter operator lists", () => {
  it("match graphql-types' operator vocabulary", () => {
    expect([...FILTER_VALUE_OPERATORS].sort()).toEqual([...CORE_VALUE_FUNCS].sort());
    expect([...FILTER_REGEX_OPERATORS].sort()).toEqual([...REGEX_VALUE_FUNCS].sort());
    expect([...FILTER_LIST_OPERATORS].sort()).toEqual([...SQL_ARRAY_VALUES].sort());
  });
});
