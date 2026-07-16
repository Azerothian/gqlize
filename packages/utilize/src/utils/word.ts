export function capitalize(word = "") {
  if (word === "" || !word) {
    return "";
  }
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

export function lowercase(word = "") {
  if (word === "") {
    return "";
  }
  return `${word.charAt(0).toLowerCase()}${word.slice(1)}`;
}

/** @deprecated misspelled alias of {@link lowercase}; kept for compatibility. */
export const lowecase = lowercase;
