import { createResource } from './resource';
import type { Bank, BankPayload } from '../types';

export const banksApi = createResource<Bank, BankPayload>('/banks');
