// Catálogo inventado para medir la interpretación. Sirve también de referencia a cases.json,
// que nombra cuentas, tarjetas y categorías por su nombre aquí, nunca por id.
import type { MovementCatalog } from '../src/whatsapp/parser';

const ANDINO = 1;
const LITORAL = 2;
const SIERRA = 3;

export const EVAL_CATALOG: MovementCatalog = {
  accounts: [
    { id: 11, name: 'Ahorros Andino', bankName: 'Banco Andino', bankId: ANDINO, accountKind: 'SAVINGS', accountNumber: '2200001234', type: 'BANK' },
    { id: 12, name: 'Corriente Andino', bankName: 'Banco Andino', bankId: ANDINO, accountKind: 'CHECKING', accountNumber: '3300005678', type: 'BANK' },
    { id: 13, name: 'B.L-Sueldo', bankName: 'Banco Litoral', bankId: LITORAL, accountKind: 'SAVINGS', accountNumber: '4400004321', type: 'BANK' },
    { id: 14, name: 'C.S.N-Socio', bankName: 'Cooperativa Sierra Norte', bankId: SIERRA, accountKind: 'SAVINGS', accountNumber: '5500007788', type: 'BANK' },
    { id: 15, name: 'Caja chica', bankName: null, bankId: null, accountKind: null, accountNumber: null, type: 'CASH' }
  ],
  cards: [
    { id: 21, name: 'Visa Andino', bankName: 'Banco Andino', bankId: ANDINO, last4: '1111', type: 'CREDIT' },
    { id: 22, name: 'Mastercard Litoral', bankName: 'Banco Litoral', bankId: LITORAL, last4: '2222', type: 'CREDIT' },
    // El débito se resuelve a su cuenta: mismo banco y mismo nombre de titular.
    { id: 23, name: 'B.L-Sueldo', bankName: 'Banco Litoral', bankId: LITORAL, last4: '3333', type: 'DEBIT' },
    { id: 24, name: 'C.S.N-Socio', bankName: 'Cooperativa Sierra Norte', bankId: SIERRA, last4: '4444', type: 'DEBIT' }
  ],
  categories: [
    { id: 31, name: 'Alimentación' },
    { id: 32, name: 'Transporte' },
    { id: 33, name: 'Salud' },
    { id: 34, name: 'Servicios' },
    { id: 35, name: 'Arriendo' },
    { id: 36, name: 'Educación' },
    { id: 37, name: 'Entretenimiento' },
    { id: 38, name: 'Ropa' },
    { id: 39, name: 'Mascotas' },
    { id: 40, name: 'Sueldo' },
    { id: 41, name: 'Ventas' }
  ]
};
