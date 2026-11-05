// deno test supabase/functions/_shared/shared-meeting.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isInvited, SHARED_STATUSES, sharedWindow } from "./shared-meeting.ts";

const deLuis = [
  { email: "pedro@miempresa.example", name: null, responseStatus: "accepted" },
  { email: "Luis@miempresa.example", name: null, responseStatus: "accepted" },
  { email: "cliente@gmail.com", name: null, responseStatus: "accepted" },
];

Deno.test("isInvited: manda la lista de invitados del dueño", () => {
  assert(isInvited(deLuis, "pedro@miempresa.example"));
  assert(isInvited(deLuis, "luis@miempresa.example"));
  assert(isInvited(deLuis, " Pedro@MiEmpresa.example "));
  // Alguien que copió el link de Meet a un evento propio no está en esa lista.
  assert(!isInvited(deLuis, "intruso@miempresa.example"));
  assert(!isInvited(deLuis, null));
  assert(!isInvited(null, "pedro@miempresa.example"));
  assert(!isInvited([], "pedro@miempresa.example"));
  assert(!isInvited([{ email: null }, "pedro@miempresa.example", 3], "pedro@miempresa.example"));
});

Deno.test("sharedWindow: la misma hora sí, la recurrencia de mañana no", () => {
  const { from, to } = sharedWindow(new Date("2026-10-06T16:00:00Z"));
  const dentro = (iso: string) => iso >= from && iso <= to;
  assert(dentro("2026-10-06T16:00:00.000Z"));
  assert(!dentro("2026-10-07T16:00:00.000Z"));
  assert(!dentro("2026-10-06T13:00:00.000Z"));
});

Deno.test("SHARED_STATUSES: solo estados que existen y que no son un fracaso", () => {
  const enumBD = ["scheduled", "recording", "processing", "completed", "failed", "not_recorded"];
  for (const s of SHARED_STATUSES) assert(enumBD.includes(s), s);
  assert(!SHARED_STATUSES.includes("not_recorded") && !SHARED_STATUSES.includes("failed"));
});
