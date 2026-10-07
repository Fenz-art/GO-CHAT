export type WorkspaceOrientationStatus = "pending" | "dismissed";

const prefix = "gochat.workspace.orientation.v1";

export function workspaceOrientationKey(userId: string) {
  return `${prefix}.${userId}`;
}

export function shouldOpenWorkspaceOrientation(value: string | null) {
  return value === "pending";
}
