export type ResumedIdentity = { username: string; userId: string };

export type OnboardingResumeState = {
  userId?: string;
  step?: string;
  candidateUsername?: string;
  username?: string;
  completed?: boolean;
};

export function completedIdentityFromResume(state: OnboardingResumeState | null | undefined): ResumedIdentity | null {
  if (!state?.completed || !state.userId || !state.username) return null;
  return { username: state.username, userId: state.userId };
}
