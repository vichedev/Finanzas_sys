import { createResource } from './resource';
import type { Account, AccountPayload } from '../types';

export const accountsApi = createResource<Account, AccountPayload>('/accounts');
