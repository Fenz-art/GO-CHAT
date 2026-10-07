export type ExpiryState = "none" | "active" | "near" | "due";

const oneHourMs = 60 * 60 * 1_000;

export function expiryState(expiresAt: string | undefined, now: number): ExpiryState {
  if (!expiresAt) return "none";
  const remaining = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remaining) || remaining <= 0) return "due";
  return remaining <= oneHourMs ? "near" : "active";
}

export function expiryLabel(expiresAt: string, now: number) {
  const remaining = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remaining) || remaining <= 0) return "Expires shortly";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.ceil(hours / 24)}d`;
}
