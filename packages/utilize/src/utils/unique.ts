export default function unique<T>(arr: T[]): T[] {
  // Set-based dedup is linear; the previous indexOf filter was O(n^2).
  return Array.from(new Set(arr));
}
