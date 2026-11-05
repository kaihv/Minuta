// Enlaces de videollamada que la app acepta para mandar el bot a mano.

const MEETING_HOSTS = [
  /^meet\.google\.com$/,
  /(^|\.)zoom\.us$/,
  /^teams\.microsoft\.com$/,
  /^teams\.live\.com$/,
  /(^|\.)webex\.com$/,
];

/** Solo enlaces https de plataformas de videollamada conocidas; si no, null. */
export function validMeetingUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (!MEETING_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))) return null;
    return u.toString();
  } catch (_e) {
    return null;
  }
}
