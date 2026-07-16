
export default function unique(arr: any[]) {
  // Set-based dedup is linear; the previous indexOf filter was O(n^2).
  return Array.from(new Set(arr));
}
