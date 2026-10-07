export type SessionExitKind = "account" | "identity";

export function sessionExitSummary(kind: SessionExitKind, username: string) {
  if (kind === "account") {
    return {
      title: "Account signed out",
      detail: `@${username} remains active on this browser. Your chats and identity were not deleted.`,
    };
  }
  return {
    title: "Signed out of this identity",
    detail: "This browser session is closed. Your chats and identity were not deleted.",
  };
}
