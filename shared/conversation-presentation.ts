type TimelineMessage = { senderId: string; createdAt: string } & Record<string, unknown>;

export function messageDayKey(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function startsMessageDay(current: TimelineMessage, previous?: TimelineMessage) {
  return !previous || messageDayKey(previous.createdAt) !== messageDayKey(current.createdAt);
}

export function startsPeerMessageGroup(current: TimelineMessage, previous: TimelineMessage | undefined, localUserId: string) {
  if (current.senderId === localUserId) return false;
  return !previous || previous.senderId !== current.senderId || startsMessageDay(current, previous);
}
