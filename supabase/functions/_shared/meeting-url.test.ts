import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validMeetingUrl } from "./meeting-url.ts";

Deno.test("validMeetingUrl: acepta Meet, Zoom, Teams y Webex por https", () => {
  for (const ok of [
    "https://meet.google.com/abc-defg-hij",
    " https://us02web.zoom.us/j/123?pwd=x ",
    "https://zoom.us/j/1",
    "https://teams.microsoft.com/l/meetup-join/xyz",
    "https://empresa.webex.com/meet/ana",
  ]) assertEquals(validMeetingUrl(ok) !== null, true, ok);
});

Deno.test("validMeetingUrl: rechaza http, otros sitios, trucos de dominio y basura", () => {
  for (const bad of [
    "http://meet.google.com/abc",
    "https://meet.google.com.evil.example/abc",
    "https://evilzoom.us/j/1",
    "https://user:pass@meet.google.com/abc",
    "javascript:alert(1)",
    "meet.google.com/abc",
    "",
    null,
    42,
  ]) assertEquals(validMeetingUrl(bad), null, String(bad));
});
