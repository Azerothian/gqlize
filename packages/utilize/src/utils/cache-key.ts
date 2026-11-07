/**
 * The key a read-cache entry lives under: the read's shape (everything that
 * decides the result, already hashed) and the generation of each of its tags,
 * in tag order.
 *
 * Plain rather than hashed, so a store can build the identical string
 * server-side: `IORedisCacheStore.lookup` does, in Lua, to read the generations
 * and the entry in one round trip. Change this and that script together.
 */
export function cacheEntryKey(shape: string, versions: number[]): string {
  return `${shape}:${versions.join(".")}`;
}
