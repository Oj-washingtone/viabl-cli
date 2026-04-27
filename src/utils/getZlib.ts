let _zlibPromise: Promise<typeof import("zlib")> | null = null;
export async function getZlib() {
  if (!_zlibPromise) _zlibPromise = import("zlib");
  return _zlibPromise;
}
