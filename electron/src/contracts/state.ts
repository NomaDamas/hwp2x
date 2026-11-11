export const CONTRACT_VERSION = 1 as const;
/** 기존 conversion-state.json version 1을 변경하지 않는다. */
export const PROFILE_VERSION = 1 as const;
export type RunPhase = "idle" | "scanning" | "converting" | "paused" | "stopped" | "done";
export interface ProgressContract { total: number; completed: number; percent: number }
export interface ErrorContract { message: string; code: string | null }
export interface RecoveryContract {
  canResume: boolean;
  /** 원본 복원은 cleanup-state.canRollback만이 판정한다. */
  rollbackAuthority: "cleanup-state";
}
export interface StateContract {
  contractVersion: typeof CONTRACT_VERSION;
  settingsVersion: typeof PROFILE_VERSION;
  phase: RunPhase;
  progress: ProgressContract;
  unprocessed: { waiting: number; failed: number; skipped: number };
  recovery: RecoveryContract;
}
