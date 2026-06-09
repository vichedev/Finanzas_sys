import { createResource } from './resource';
import type { Wallet, WalletPayload } from '../types';

export const walletsApi = createResource<Wallet, WalletPayload>('/wallets');
