/**
 * Who may do what in a room. The host created the room (and holds its host key)
 * and is drawn as the sun; speakers are chosen by the host; everyone else is a guest.
 * Only the host and speakers may send voice.
 */
export const ROLES = ["guest", "speaker", "host"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { guest: "Guest", speaker: "Speaker", host: "Host" };

export function roleIndex(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleFromIndex(index: number): Role | null {
  return ROLES[index] ?? null;
}

export function canSpeak(role: Role): boolean {
  return role !== "guest";
}
