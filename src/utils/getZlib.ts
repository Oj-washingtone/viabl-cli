let _zlib: typeof import("zlib") | null = null;

export async function getZlib() {
  if (!_zlib) _zlib = await import("zlib");
  return _zlib;
}
