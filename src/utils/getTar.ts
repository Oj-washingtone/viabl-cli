let _tar: typeof import("tar-fs") | null = null;

export async function getTar() {
  if (!_tar) _tar = await import("tar-fs");
  return _tar;
}
