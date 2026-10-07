export type ChatStateMessage = {
  id: string;
  body: string;
  senderId: string;
  state: string;
  createdAt: string;
  cursor?: number;
  clientOperationId?: string;
  read?: boolean;
  kind?: string;
  editedAt?: string;
  deletedAt?: string;
  mediaUrl?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  expiresAt?: string;
};

export function mergeRealtimeMessage(current: ChatStateMessage[], incoming: ChatStateMessage) {
  const existing = current.findIndex((item) => item.id === incoming.id || (item.clientOperationId && item.clientOperationId === incoming.clientOperationId));
  const next = existing >= 0 ? current.map((item, index) => index === existing ? incoming : item) : [...current, incoming];
  return next.sort((left, right) => (left.cursor ?? Number.MAX_SAFE_INTEGER) - (right.cursor ?? Number.MAX_SAFE_INTEGER));
}

export function applyReadReceipt(current: ChatStateMessage[], messageId: string) {
  return current.map((message) => message.id === messageId ? { ...message, read: true, state: message.state === "sent" || message.state === "delivered" ? "read" : message.state } : message);
}

export function filterMessageHistory(messages: ChatStateMessage[], query: string, fromDate: string, toDate: string) {
  const normalized = query.trim().toLowerCase();
  return messages.filter((message) => {
    const matchesText = !normalized || message.body.toLowerCase().includes(normalized);
    const created = new Date(message.createdAt);
    const matchesFrom = !fromDate || created >= new Date(`${fromDate}T00:00:00`);
    const matchesTo = !toDate || created <= new Date(`${toDate}T23:59:59.999`);
    return matchesText && matchesFrom && matchesTo;
  });
}
