export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function toPage<T>(data: T[], page: number, limit: number, total: number): Page<T> {
  return { data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Replace Mongo's `_id`/`__v` with a plain string `id` for API responses. */
export function withId<T extends { _id: unknown }>(doc: T): Omit<T, "_id" | "__v"> & { id: string } {
  const { _id, __v: _v, ...rest } = doc as T & { __v?: unknown };
  void _v;
  return { id: String(_id), ...rest } as Omit<T, "_id" | "__v"> & { id: string };
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
