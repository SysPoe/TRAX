/**
 * Integer handle interning for high-volume identities.
 * Public IDs remain string-encoded; internal indexes use numeric handles to reduce
 * heap overhead and allow typed postings.
 */
export class HandleTable {
  private strToHandle = new Map<string, number>();
  private handleToStr: string[] = ['']; // 0 reserved for invalid
  private next = 1;

  intern(key: string): number {
    let h = this.strToHandle.get(key);
    if (h !== undefined) return h;
    h = this.next++;
    this.strToHandle.set(key, h);
    this.handleToStr[h] = key;
    return h;
  }
  resolve(handle: number): string {
    return this.handleToStr[handle] ?? '';
  }
  has(key: string): boolean { return this.strToHandle.has(key); }
  size(): number { return this.next - 1; }
}

export const tripHandleTable = new HandleTable();
export const stopHandleTable = new HandleTable();
export const serviceHandleTable = new HandleTable();

export function tripHandleFor(feedId: string, localId: string): number {
  return tripHandleTable.intern(`${feedId}\0${localId}`);
}
export function stopHandleFor(feedId: string, localId: string): number {
  return stopHandleTable.intern(`${feedId}\0${localId}`);
}
export function serviceHandleFor(feedId: string, localId: string): number {
  return serviceHandleTable.intern(`${feedId}\0${localId}`);
}
export function decodeTripHandle(handle: number): { feedId: string; localId: string } {
  const s = tripHandleTable.resolve(handle);
  const idx = s.indexOf('\0');
  return { feedId: s.slice(0, idx), localId: s.slice(idx+1) };
}
export function decodeStopHandle(handle: number): { feedId: string; localId: string } {
  const s = stopHandleTable.resolve(handle);
  const idx = s.indexOf('\0');
  return { feedId: s.slice(0, idx), localId: s.slice(idx+1) };
}
