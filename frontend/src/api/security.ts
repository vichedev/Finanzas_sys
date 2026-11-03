import { http } from './http';

export type LoginEventType =
  | 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOCKED_ATTEMPT' | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_UNLOCKED' | 'IP_BLOCKED' | 'IP_UNBLOCKED';

export interface LoginEvent {
  id: string;
  type: LoginEventType;
  email: string | null;
  ip: string | null;
  reason: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  account: { locked: boolean; self: boolean } | null;
  ipBlocked: boolean;
}

export interface LockedAccount {
  kind: 'membership' | 'super';
  id: string;
  email: string;
  name: string;
  lockedUntil: string;
  company: string | null;
}

export interface BlockedIp {
  ip: string;
  blockedUntil: string;
  strikes: number;
  failureCount: number;
  accountCount: number;
  blockedAttempts: number;
}

export const securityApi = {
  events: (params: { type?: LoginEventType; search?: string; limit: number; offset: number }) =>
    http.get<{ total: number; currentIp: string | null; events: LoginEvent[] }>('/security/events', { params }).then((r) => r.data),
  blocks: () =>
    http.get<{ accounts: LockedAccount[]; ips: BlockedIp[] }>('/security/blocks').then((r) => r.data),
  unlockAccount: (kind: LockedAccount['kind'], id: string) =>
    http.post('/security/accounts/unlock', { kind, id }),
  lockAccountByEmail: (email: string, minutes: number) => http.post('/security/accounts/lock', { email, minutes }),
  unlockAccountByEmail: (email: string) => http.post('/security/accounts/unlock-email', { email }),
  blockIp: (ip: string, minutes: number) => http.post('/security/ips/block', { ip, minutes }),
  unblockIp: (ip: string) => http.post('/security/ips/unblock', { ip })
};
