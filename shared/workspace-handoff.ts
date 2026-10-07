import { goChatRoutes } from "@/shared/onboarding-routing";

export function completeWorkspaceHandoff(history: Pick<History, "replaceState">) {
  history.replaceState(null, "", goChatRoutes.home);
}
