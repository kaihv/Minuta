import { describe, expect, it } from "vitest";
import { audioExtension, clock, groupTurns, notRecordedText, transcriptText } from "./format";

describe("format", () => {
  it("clock", () => {
    expect(clock(65_000)).toBe("01:05");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(clock(-5)).toBe("00:00");
  });

  it("groupTurns junta turnos seguidos del mismo hablante", () => {
    const g = groupTurns([
      { id: "1", speaker_name: "Ana", content: "Hola", start_time_ms: 0 },
      { id: "2", speaker_name: "Ana", content: "¿Partimos?", start_time_ms: 3000 },
      { id: "3", speaker_name: "Luis", content: "Sí", start_time_ms: 5000 },
      { id: "4", speaker_name: "Luis", content: "Después", start_time_ms: 60_000 },
    ]);
    expect(g.map((x) => [x.speaker, x.parts.length])).toEqual([["Ana", 2], ["Luis", 1], ["Luis", 1]]);
  });

  it("transcriptText", () => {
    const t = transcriptText({ title: "Pedido", scheduled_at: null, created_at: "2026-11-04T15:00:00Z" }, [
      { id: "1", speaker_name: null, content: "Hola", start_time_ms: 61_000 },
    ]);
    expect(t.startsWith("Pedido\n")).toBe(true);
    expect(t.endsWith("[01:01] Participante: Hola")).toBe(true);
  });

  it("notRecordedText", () => {
    expect(notRecordedText("bot_create_failed: 401")).toContain("Recall");
    expect(notRecordedText(null)).toContain("sin grabación");
  });

  it("audioExtension", () => {
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("audio/mp4")).toBe("mp4");
    expect(audioExtension("", "nota.M4A")).toBe("m4a");
    expect(audioExtension("application/pdf", "x.pdf")).toBeNull();
  });
});
