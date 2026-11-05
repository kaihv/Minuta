import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isOver } from "./quota.ts";

Deno.test("isOver: tope alcanzado, cero apaga, valores raros cuentan como cero", () => {
  assertEquals(isOver(0, 15), false);
  assertEquals(isOver(14, 15), false);
  assertEquals(isOver(15, 15), true);
  assertEquals(isOver(0, 0), true);
  assertEquals(isOver(0, null), true);
  assertEquals(isOver(0, -1), true);
});
