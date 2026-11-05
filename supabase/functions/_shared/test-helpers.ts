// Base de datos en memoria con la forma mínima del cliente supabase-js que usan
// los módulos compartidos. Solo para pruebas: imita el tope de 1.000 filas por
// respuesta de PostgREST, que es justo lo que el lector paginado debe superar.

type Row = Record<string, unknown>;

// Comparación como en SQL: con nulo no hay resultado; números como números.
function cmp(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

interface Filter {
  op: "eq" | "in" | "is" | "not_is" | "gte" | "lte" | "lt" | "gt" | "ilike";
  col: string;
  val: unknown;
}

export interface FakeDbOptions {
  maxRows?: number;
  /** Falla el insert número N (1 = el primero) en esa tabla. */
  failInsert?: { table: string; onCall: number; message?: string };
  /** Columnas con restricción única por tabla (responde 23505 como Postgres).
   *  "a+b" declara una clave compuesta. */
  unique?: Record<string, string[]>;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  calls: { table: string; action: string; rows?: number }[] = [];
  private insertCalls: Record<string, number> = {};
  private seq = 0;
  constructor(public opts: FakeDbOptions = {}) {}

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return this;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    const filters: Filter[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let action: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let head = false;
    let wantCount = false;
    let returning = false;
    let single: "single" | "maybe" | null = null;

    const matches = (row: Row) =>
      filters.every((f) => {
        const v = row[f.col];
        switch (f.op) {
          case "eq": return v === f.val;
          case "in": return (f.val as unknown[]).includes(v);
          case "is": return (v ?? null) === f.val;
          case "not_is": return (v ?? null) !== f.val;
          case "gte": return cmp(v, f.val) !== null && cmp(v, f.val)! >= 0;
          case "lte": return cmp(v, f.val) !== null && cmp(v, f.val)! <= 0;
          case "gt": return cmp(v, f.val) !== null && cmp(v, f.val)! > 0;
          case "lt": return cmp(v, f.val) !== null && cmp(v, f.val)! < 0;
          case "ilike": {
            const pattern = String(f.val).toLowerCase().replaceAll("%", "");
            return String(v ?? "").toLowerCase().includes(pattern);
          }
        }
      });

    const run = () => {
      const all = db.tables[table] ?? (db.tables[table] = []);
      if (action === "insert") {
        const n = (db.insertCalls[table] = (db.insertCalls[table] ?? 0) + 1);
        const list = Array.isArray(payload) ? payload : [payload as Row];
        db.calls.push({ table, action, rows: list.length });
        const fail = db.opts.failInsert;
        if (fail && fail.table === table && fail.onCall === n) {
          return { data: null, error: { message: fail.message ?? "fallo simulado", code: "XX000" } };
        }
        for (const col of db.opts.unique?.[table] ?? []) {
          const key = (r: Row) => col.split("+").map((c) => String(r[c])).join("\u0001");
          if (list.some((r) => all.some((x) => key(x) === key(r)))) {
            return { data: null, error: { message: `duplicate key value violates unique constraint (${col})`, code: "23505" } };
          }
        }
        const created = list.map((r) => ({ id: r.id ?? `id-${String(++db.seq).padStart(6, "0")}`, ...r }));
        all.push(...created);
        return { data: returning ? created : null, error: null };
      }
      if (action === "update") {
        const hit = all.filter(matches);
        hit.forEach((r) => Object.assign(r, payload));
        db.calls.push({ table, action, rows: hit.length });
        const data = returning ? hit.map((r) => ({ ...r })) : null;
        if (single) return { data: data?.[0] ?? null, error: null };
        return { data, error: null };
      }
      if (action === "delete") {
        const keep = all.filter((r) => !matches(r));
        db.calls.push({ table, action, rows: all.length - keep.length });
        db.tables[table] = keep;
        return { data: null, error: null };
      }
      let out = all.filter(matches).map((r) => ({ ...r }));
      for (const o of [...orders].reverse()) {
        out.sort((a, b) => {
          const x = a[o.col] as number | string, y = b[o.col] as number | string;
          return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
        });
      }
      const count = out.length;
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      out = out.slice(0, db.opts.maxRows ?? 1000);
      db.calls.push({ table, action, rows: out.length });
      if (head) return { data: null, count, error: null };
      if (single) return { data: out[0] ?? null, error: null, count: wantCount ? count : undefined };
      return { data: out, error: null, count: wantCount ? count : undefined };
    };

    // deno-lint-ignore no-explicit-any
    const q: any = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        if (action === "select") {
          head = !!o?.head;
          wantCount = !!o?.count;
        } else {
          returning = true;
        }
        return q;
      },
      insert(p: Row | Row[]) { action = "insert"; payload = p; return q; },
      update(p: Row) { action = "update"; payload = p; return q; },
      delete() { action = "delete"; return q; },
      eq(col: string, val: unknown) { filters.push({ op: "eq", col, val }); return q; },
      in(col: string, val: unknown[]) { filters.push({ op: "in", col, val }); return q; },
      is(col: string, val: unknown) { filters.push({ op: "is", col, val }); return q; },
      not(col: string, _op: string, val: unknown) { filters.push({ op: "not_is", col, val }); return q; },
      gte(col: string, val: unknown) { filters.push({ op: "gte", col, val }); return q; },
      lte(col: string, val: unknown) { filters.push({ op: "lte", col, val }); return q; },
      gt(col: string, val: unknown) { filters.push({ op: "gt", col, val }); return q; },
      lt(col: string, val: unknown) { filters.push({ op: "lt", col, val }); return q; },
      ilike(col: string, val: unknown) { filters.push({ op: "ilike", col, val }); return q; },
      or(_expr: string) { return q; }, // no se evalúa: las pruebas que lo usan filtran aparte
      order(col: string, o?: { ascending?: boolean }) { orders.push({ col, asc: o?.ascending !== false }); return q; },
      range(a: number, b: number) { range = [a, b]; return q; },
      limit(n: number) { limit = n; return q; },
      single() { single = "single"; return q; },
      maybeSingle() { single = "maybe"; return q; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return q;
  }
}
