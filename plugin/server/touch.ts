const norm = (e: string) => e.replace(/\/\*\*$/, "/");
export const normTouch = norm;
export function matchTouch(entry: string, file: string): boolean {
  const e = norm(entry);
  return e.endsWith("/") ? file.startsWith(e) : file === e;
}
