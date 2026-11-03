// Pruebas de la revisión de lo que interpreta la IA. Función pura: sin base ni clave de IA.
// Uso (desde backend): npx tsx --test tests/ai-review.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedMovement } from '../src/whatsapp/parser';
import { reviewParsed, type ReviewContext } from '../src/whatsapp/reviewParsed';
import { todayEcuador } from '../src/lib/ecuadorDate';

const TODAY = '2026-11-03';

const ANDINO_AH = { id: 1, name: 'Andino Ahorros', bankName: 'Banco Andino', accountKind: 'SAVINGS', accountNumber: '2200004567' };
const ANDINO_CO = { id: 2, name: 'Andino Corriente', bankName: 'Banco Andino', accountKind: 'CHECKING', accountNumber: '3300001111' };
const LITORAL = { id: 3, name: 'Principal', bankName: 'Banco Litoral', accountKind: 'SAVINGS', accountNumber: '4400002222' };
const VISA = { id: 10, name: 'Visa Oro', bankName: 'Banco Andino', last4: '9876', type: 'CREDIT' };
const MASTER = { id: 11, name: 'Mastercard Negra', bankName: 'Banco Litoral', last4: '5432', type: 'CREDIT' };

function movement(over: Partial<ParsedMovement> = {}): ParsedMovement {
  return {
    understood: true, intent: 'register', type: 'EXPENSE', amount: 20, description: 'Gasto', bankHint: null,
    accountId: null, toAccountId: null, cardId: null, categoryId: null, categoryCandidates: null,
    paymentMethod: null, date: TODAY, isCredit: false, vendor: null, familyMember: null, notes: null, clarification: null,
    ...over
  };
}

function context(text: string, over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    text, today: TODAY, accounts: [ANDINO_AH, LITORAL], cards: [VISA, MASTER],
    categoryIds: [100, 101, 102], amountStats: null, ...over
  };
}

const codes = (r: ReturnType<typeof reviewParsed>) => r.issues.map((i) => i.code);

describe('todayEcuador', () => {
  test('a las 02:00 UTC todavía es el día anterior en Ecuador', () => {
    assert.equal(todayEcuador(new Date('2026-11-04T02:00:00Z')), '2026-11-03');
  });
  test('a las 05:00 UTC ya es el mismo día en Ecuador', () => {
    assert.equal(todayEcuador(new Date('2026-11-04T05:00:00Z')), '2026-11-04');
  });
  test('sin argumento devuelve el formato AAAA-MM-DD', () => {
    assert.match(todayEcuador(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('intención', () => {
  test('una consulta no se revisa', () => {
    const p = movement({ intent: 'query', amount: -5, accountId: 999, date: 'mal' });
    const r = reviewParsed(p, context('¿cuánto gasté?'));
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.dropped, []);
    assert.equal(r.parsed.accountId, 999);
    assert.equal(r.parsed.amount, -5);
  });
});

describe('ids fuera de catálogo', () => {
  test('quita cuenta, destino, tarjeta y categoría que no existen', () => {
    const r = reviewParsed(
      movement({ type: 'TRANSFER', accountId: 99, toAccountId: 98, cardId: 97, categoryId: 96, accountName: 'X', categoryName: 'Y' }),
      context('pasé 20 de una a otra')
    );
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.toAccountId, null);
    assert.equal(r.parsed.cardId, null);
    assert.equal(r.parsed.categoryId, null);
    assert.equal(r.parsed.accountName, null);
    assert.equal(r.parsed.categoryName, null);
    assert.deepEqual(r.dropped.sort(), ['accountId', 'cardId', 'categoryId', 'toAccountId']);
  });
  test('filtra las categorías candidatas y lo registra', () => {
    const r = reviewParsed(movement({ categoryId: 100, categoryCandidates: [100, 555, 101] }), context('gasté 20'));
    assert.deepEqual(r.parsed.categoryCandidates, [100, 101]);
    assert.equal(r.parsed.categoryId, 100);
    assert.deepEqual(r.dropped, ['categoryCandidates']);
  });
  test('candidatas válidas no se registran como quitadas', () => {
    const r = reviewParsed(movement({ categoryCandidates: [100, 101] }), context('gasté 20'));
    assert.deepEqual(r.dropped, []);
  });
});

describe('monto no válido', () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    test(`el monto ${bad} se quita`, () => {
      const r = reviewParsed(movement({ amount: bad }), context('gasté 20'));
      assert.equal(r.parsed.amount, null);
      assert.deepEqual(r.dropped, ['amount']);
      assert.deepEqual(r.issues, []);
    });
  }
  test('un monto que no es número se quita', () => {
    const r = reviewParsed(movement({ amount: 'veinte' as unknown as number }), context('gasté veinte'));
    assert.equal(r.parsed.amount, null);
    assert.deepEqual(r.dropped, ['amount']);
  });
  test('un monto como texto se convierte', () => {
    const r = reviewParsed(movement({ amount: '20' as unknown as number }), context('gasté 20'));
    assert.equal(r.parsed.amount, 20);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.issues, []);
  });
  test('un monto como texto con decimales se convierte y se coteja', () => {
    const r = reviewParsed(movement({ amount: '200.5' as unknown as number }), context('gasté 20'));
    assert.equal(r.parsed.amount, 200.5);
    assert.deepEqual(codes(r), ['AMOUNT_MISMATCH']);
  });
  for (const bad of ['', ' ', 'Infinity', '-3', '0', true, {}]) {
    test(`el monto ${JSON.stringify(bad)} se quita`, () => {
      const r = reviewParsed(movement({ amount: bad as unknown as number }), context('gasté 20'));
      assert.equal(r.parsed.amount, null);
      assert.deepEqual(r.dropped, ['amount']);
    });
  }
});

describe('monto contra el texto', () => {
  const fits: [string, number][] = [
    ['gasté 3.098 en arriendo', 3098],
    ['gasté 3,098 en arriendo', 3098],
    ['gasté 3,98 en café', 3.98],
    ['gasté 3.98 en café', 3.98],
    ['pagué 3.098,50 de arriendo', 3098.5],
    ['pagué 3,098.50 de arriendo', 3098.5],
    ['almuerzo $20', 20],
    ['almuerzo 20usd', 20],
    ['almuerzo 20 dólares', 20]
  ];
  for (const [text, amount] of fits) {
    test(`"${text}" coincide con ${amount}`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(text))), []);
    });
  }

  test('monto distinto pregunta y ofrece conservar y el número del texto', () => {
    const r = reviewParsed(movement({ amount: 30980 }), context('gasté 3.098 en arriendo'));
    assert.deepEqual(codes(r), ['AMOUNT_MISMATCH']);
    const issue = r.issues[0];
    assert.match(issue.question, /^¿El monto es \$.*\?$/);
    assert.deepEqual(issue.options[0].patch, { amount: 30980 });
    assert.deepEqual(issue.options.slice(1).map((o) => o.patch), [{ amount: 3098 }]);
  });
  test('ofrece como máximo tres números distintos además de conservar', () => {
    const r = reviewParsed(movement({ amount: 999 }), context('10 o 20 o 30 o 40 o 10'));
    assert.deepEqual(r.issues[0].options.map((o) => o.patch.amount), [999, 10, 20, 30]);
  });
  test('no quita el monto: solo pregunta', () => {
    const r = reviewParsed(movement({ amount: 200 }), context('gasté 20 en el súper'));
    assert.equal(r.parsed.amount, 200);
    assert.deepEqual(r.dropped, []);
  });
  test('tres mil noventa y ocho en palabras no pregunta', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 3098 }), context('Tres mil noventa y ocho en arriendo'))), []);
  });
  test('palabras junto a un número ignorado no preguntan', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 3098 }), context('tres mil noventa y ocho el 5 de noviembre'))), []);
  });
  test('el número pegado a un mes y que no es día sigue contando', () => {
    const r = reviewParsed(movement({ amount: 8000 }), context('sueldo de octubre 800'));
    assert.deepEqual(codes(r), ['AMOUNT_MISMATCH']);
  });
  test('un número sin relación sí pregunta aunque haya un número ignorado', () => {
    const r = reviewParsed(movement({ amount: 200 }), context('gasté 30 el 5 de noviembre con la 4567'));
    assert.deepEqual(codes(r), ['AMOUNT_MISMATCH']);
    assert.deepEqual(r.issues[0].options.map((o) => o.patch.amount), [200, 30]);
  });

  const ignored: [string, number][] = [
    ['pagué con la que termina en 4567', 20],
    ['pagué con ****4567', 20],
    ['pagué con la 4567', 20],
    ['gasté el 5', 20],
    ['gasté el 5 de noviembre', 20],
    ['gasté 5 de noviembre del 2026', 20],
    ['gasté el 05/11', 20],
    ['gasté el 05/11/2026', 20],
    ['pago factura 001-001-000123', 20],
    ['pago factura No. 12345', 20],
    ['pago factura #555', 20],
    ['pagué el lunes 3', 20],
    ['ayer a las 5 pagué', 20],
    ['pagué a las 15:30', 20],
    ['con el 15% de iva', 20],
    ['hace 3 días pagué', 20],
    ['pagué al 0991234567', 20]
  ];
  for (const [text, amount] of ignored) {
    test(`"${text}" no respalda un monto que no aparece`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(text))), ['AMOUNT_UNSUPPORTED']);
    });
    test(`"${text} por ${amount}" ignora el número ajeno`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(`${text} por ${amount}`))), []);
    });
  }
});

describe('monto inusual', () => {
  test('supera p95 × 10 con historial', () => {
    const r = reviewParsed(movement({ amount: 501 }), context('gasté 501', { amountStats: { count: 10, p95: 50 } }));
    assert.deepEqual(codes(r), ['AMOUNT_UNUSUAL']);
    assert.equal(r.issues[0].free, 'amount');
    assert.deepEqual(r.issues[0].options[0].patch, { amount: 501 });
  });
  test('justo en p95 × 10 no es inusual', () => {
    const r = reviewParsed(movement({ amount: 500 }), context('gasté 500', { amountStats: { count: 10, p95: 50 } }));
    assert.deepEqual(codes(r), []);
  });
  test('con p95 pequeño el piso es 100', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 100 }), context('gasté 100', { amountStats: { count: 20, p95: 1 } }))), []);
    assert.deepEqual(codes(reviewParsed(movement({ amount: 101 }), context('gasté 101', { amountStats: { count: 20, p95: 1 } }))), ['AMOUNT_UNUSUAL']);
  });
  test('con menos de 10 movimientos solo avisa desde 100000', () => {
    const few = { amountStats: { count: 9, p95: 1 } };
    assert.deepEqual(codes(reviewParsed(movement({ amount: 99999 }), context('gasté 99999', few))), []);
    assert.deepEqual(codes(reviewParsed(movement({ amount: 100000 }), context('gasté 100000', few))), ['AMOUNT_UNUSUAL']);
  });
  test('sin estadísticas avisa desde 100000', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 100000 }), context('gasté 100000'))), ['AMOUNT_UNUSUAL']);
  });
  test('no se repite si ya hay diferencia con el texto', () => {
    const r = reviewParsed(movement({ amount: 200000 }), context('gasté 200'));
    assert.deepEqual(codes(r), ['AMOUNT_MISMATCH']);
  });
});

describe('fecha', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '03/11/2026', 'ayer', '2026-1-5', '']) {
    test(`"${bad}" se quita para que el flujo use hoy`, () => {
      const r = reviewParsed(movement({ date: bad }), context('gasté 20'));
      assert.equal(r.parsed.date, null);
      assert.deepEqual(r.dropped, ['date']);
      assert.deepEqual(r.issues, []);
    });
  }
  test('una fecha inválida como número no lanza', () => {
    const r = reviewParsed(movement({ date: 20261103 as unknown as string }), context('gasté 20'));
    assert.equal(r.parsed.date, null);
  });
  test('el 29 de febrero de un bisiesto existe', () => {
    const r = reviewParsed(movement({ date: '2024-02-29' }), context('gasté 20', { today: '2024-03-01' }));
    assert.equal(r.parsed.date, '2024-02-29');
    assert.deepEqual(codes(r), []);
  });
  test('fecha futura: conservar o usar hoy', () => {
    const r = reviewParsed(movement({ date: '2026-11-04' }), context('gasté 20'));
    assert.deepEqual(codes(r), ['DATE_FUTURE']);
    assert.deepEqual(r.issues[0].options.map((o) => o.patch), [{ date: '2026-11-04' }, { date: TODAY }]);
    assert.equal(r.issues[0].free, 'date');
    assert.equal(r.parsed.date, '2026-11-04');
  });
  test('hoy no es futuro', () => {
    assert.deepEqual(codes(reviewParsed(movement({ date: TODAY }), context('gasté 20'))), []);
  });
  test('exactamente 365 días atrás se admite', () => {
    assert.deepEqual(codes(reviewParsed(movement({ date: '2025-11-03' }), context('gasté 20'))), []);
  });
  test('366 días atrás pregunta', () => {
    const r = reviewParsed(movement({ date: '2025-11-02' }), context('gasté 20'));
    assert.deepEqual(codes(r), ['DATE_TOO_OLD']);
    assert.deepEqual(r.issues[0].options.map((o) => o.patch), [{ date: '2025-11-02' }, { date: TODAY }]);
    assert.equal(r.issues[0].free, 'date');
  });
});

describe('cuenta o tarjeta sin base en el texto', () => {
  test('una cuenta Andino: se conserva', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 en el súper con Andino'));
    assert.equal(r.parsed.accountId, 1);
    assert.deepEqual(r.dropped, []);
  });
  test('dos cuentas Andino sin desempate: se quita', () => {
    const r = reviewParsed(movement({ accountId: 1, accountName: 'Andino Ahorros' }),
      context('gasté 20 en el súper con Andino', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.accountName, null);
    assert.deepEqual(r.dropped, ['accountId']);
  });
  test('"Andino ahorros" conserva la de ahorros', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 con Andino ahorros', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('"Andino ahorros" no conserva la corriente', () => {
    const r = reviewParsed(movement({ accountId: 2 }), context('gasté 20 con Andino ahorros', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, null);
  });
  test('"la 4567" conserva esa cuenta aunque haya dos del banco', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 con la 4567', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('"Andino 4567" no conserva la otra cuenta del banco', () => {
    const r = reviewParsed(movement({ accountId: 2 }), context('gasté 20 con Andino la 4567', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, null);
  });
  test('sin mención de cuenta se quita aunque sea la única', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 en el súper', { accounts: [ANDINO_AH] }));
    assert.equal(r.parsed.accountId, null);
  });
  test('cuenta de otro banco del que se menciona: se quita', () => {
    const r = reviewParsed(movement({ accountId: 3 }), context('gasté 20 con Andino'));
    assert.equal(r.parsed.accountId, null);
  });
  test('mención genérica con una sola cuenta: se conserva', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 de mi cuenta', { accounts: [ANDINO_AH] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('mención genérica con dos cuentas: se quita', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 de mi cuenta'));
    assert.equal(r.parsed.accountId, null);
  });
  test('"pagué la cuenta de la luz" no es una mención de cuenta', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('pagué la cuenta de la luz 20', { accounts: [ANDINO_AH] }));
    assert.equal(r.parsed.accountId, null);
  });
  test('"la de ahorros" con una sola de ahorros: se conserva', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 de la de ahorros', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('sin distinguir mayúsculas ni acentos', () => {
    const banks = [{ id: 7, name: 'Norte', bankName: 'Banco del Norte', accountKind: null, accountNumber: null }];
    assert.equal(reviewParsed(movement({ accountId: 7 }), context('gasté 20 con NORTE', { accounts: banks })).parsed.accountId, 7);
  });
  test('un número igual al monto no sirve de últimos 4', () => {
    const r = reviewParsed(movement({ accountId: 1, amount: 4567 }), context('pagué 4567 en arriendo'));
    assert.equal(r.parsed.accountId, null);
  });
  test('la palabra genérica del nombre no da base', () => {
    const accounts = [{ id: 8, name: 'Cuenta de Ahorros', bankName: 'Banco Sur', accountKind: 'SAVINGS', accountNumber: null }, LITORAL];
    const r = reviewParsed(movement({ accountId: 8 }), context('gasté 20 en el banco de ropa', { accounts }));
    assert.equal(r.parsed.accountId, null);
    const r2 = reviewParsed(movement({ accountId: 8 }), context('gasté 20 con cuenta de la casa', { accounts }));
    assert.equal(r2.parsed.accountId, null);
  });

  test('abreviatura B.A para Banco Andino', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 con B.A', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('abreviatura ba en minúsculas', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20 con ba', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('nombre abreviado en el catálogo: "Banco Andino" encuentra B.A-Corriente sin banco', () => {
    const accounts = [{ id: 20, name: 'B.A-Corriente', bankName: null, accountKind: null, accountNumber: null }, LITORAL];
    const r = reviewParsed(movement({ accountId: 20 }), context('gasté 20 con el Banco Andino', { accounts }));
    assert.equal(r.parsed.accountId, 20);
  });
  test('nombre abreviado en el catálogo: "Andino" solo no da base, porque ya no hay tabla de bancos', () => {
    const accounts = [{ id: 20, name: 'B.A-Personal', bankName: null, accountKind: null, accountNumber: null }, LITORAL];
    const r = reviewParsed(movement({ accountId: 20 }), context('gasté 20 con Andino', { accounts }));
    assert.equal(r.parsed.accountId, null);
  });
  for (const [bankName, text] of [['Banco del Norte', 'con bn'], ['Mi Banco Uno', 'con mbu'], ['Banco Sur', 'con b.s']] as const) {
    test(`iniciales de "${bankName}": "${text}"`, () => {
      const accounts = [{ id: 22, name: 'Personal', bankName, accountKind: null, accountNumber: null }, LITORAL];
      assert.equal(reviewParsed(movement({ accountId: 22 }), context(`gasté 20 ${text}`, { accounts })).parsed.accountId, 22);
    });
  }
  test('cte se lee como corriente y desempata', () => {
    const r = reviewParsed(movement({ accountId: 2 }), context('gasté 20 con Andino cte', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.accountId, 2);
  });
  for (const word of ['aho', 'ahorro', 'ahorros']) {
    test(`${word} se lee como ahorros y desempata`, () => {
      const r = reviewParsed(movement({ accountId: 1 }), context(`gasté 20 con Andino ${word}`, { accounts: [ANDINO_AH, ANDINO_CO] }));
      assert.equal(r.parsed.accountId, 1);
    });
  }
  test('un nombre con cte o aho da el tipo de la cuenta', () => {
    const accounts = [
      { id: 40, name: 'Andino Cte', bankName: 'Banco Andino', accountKind: null, accountNumber: null },
      { id: 41, name: 'Andino Aho', bankName: 'Banco Andino', accountKind: null, accountNumber: null }
    ];
    assert.equal(reviewParsed(movement({ accountId: 40 }), context('gasté 20 con Andino corriente', { accounts })).parsed.accountId, 40);
    assert.equal(reviewParsed(movement({ accountId: 41 }), context('gasté 20 con Andino ahorros', { accounts })).parsed.accountId, 41);
  });
  test('nombre abreviado en el catálogo: se reconoce escrito igual', () => {
    const accounts = [{ id: 21, name: 'B.L-Negocio', bankName: 'Banco Litoral', accountKind: null, accountNumber: null }, ANDINO_AH];
    const r = reviewParsed(movement({ accountId: 21 }), context('gasté 20 con b.l', { accounts }));
    assert.equal(r.parsed.accountId, 21);
  });
  test('dos cuentas del banco: una palabra propia del nombre desempata', () => {
    const accounts = [
      { id: 30, name: 'B.L-Negocio', bankName: 'Banco Litoral', accountKind: null, accountNumber: null },
      { id: 31, name: 'B.L-Personal', bankName: 'Banco Litoral', accountKind: null, accountNumber: null }
    ];
    assert.equal(reviewParsed(movement({ accountId: 30 }), context('gasté 20 con Litoral negocio', { accounts })).parsed.accountId, 30);
    assert.equal(reviewParsed(movement({ accountId: 31 }), context('gasté 20 con Litoral negocio', { accounts })).parsed.accountId, null);
  });

  test('débito por últimos 4: conserva la cuenta del mismo banco', () => {
    const debit = { id: 12, name: 'Débito', bankName: 'Banco Andino', last4: '7777', type: 'DEBIT' };
    const r = reviewParsed(movement({ accountId: 1, paymentMethod: 'DEBIT_CARD' }), context('pagué 20 con la débito 7777', { cards: [debit] }));
    assert.equal(r.parsed.accountId, 1);
  });
  test('débito por últimos 4: no conserva la cuenta de otro banco', () => {
    const debit = { id: 12, name: 'Débito', bankName: 'Banco Andino', last4: '7777', type: 'DEBIT' };
    const r = reviewParsed(movement({ accountId: 3, paymentMethod: 'DEBIT_CARD' }), context('pagué 20 con la débito 7777', { cards: [debit] }));
    assert.equal(r.parsed.accountId, null);
  });

  test('tarjeta por últimos 4', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con la que termina en 9876')).parsed.cardId, 10);
  });
  test('tarjeta por palabra del nombre', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con la visa')).parsed.cardId, 10);
  });
  test('tarjeta sin base: se quita', () => {
    const r = reviewParsed(movement({ cardId: 10, cardName: 'Visa Oro' }), context('pagué 20 en el súper'));
    assert.equal(r.parsed.cardId, null);
    assert.equal(r.parsed.cardName, null);
    assert.deepEqual(r.dropped, ['cardId']);
  });
  test('"tarjeta" genérica con una sola: se conserva', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con tarjeta', { cards: [VISA] })).parsed.cardId, 10);
  });
  test('"tarjeta" genérica con dos del mismo tipo: se quita', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con tarjeta')).parsed.cardId, null);
  });
  test('"tarjeta" genérica con una de crédito y una de débito conserva la de crédito', () => {
    const debit = { id: 12, name: 'Débito', bankName: 'Banco Sur', last4: '7777', type: 'DEBIT' };
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con tarjeta de crédito', { cards: [VISA, debit] })).parsed.cardId, 10);
  });
  test('misma entidad en crédito y débito: el tipo desempata', () => {
    const debit = { id: 12, name: 'Débito', bankName: 'Banco Andino', last4: '7777', type: 'DEBIT' };
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con tarjeta de crédito Andino', { cards: [VISA, debit] })).parsed.cardId, 10);
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 con tarjeta Andino', { cards: [VISA, debit] })).parsed.cardId, null);
  });
  test('banco que tiene tarjeta y cuenta: se analiza cada una por su lado', () => {
    const r = reviewParsed(movement({ cardId: 10 }), context('pagué 20 con la tarjeta de Andino', { accounts: [ANDINO_AH, ANDINO_CO] }));
    assert.equal(r.parsed.cardId, 10);
  });
});

describe('transferencias', () => {
  const accounts = [ANDINO_AH, ANDINO_CO, LITORAL];
  const transfer = (accountId: number | null, toAccountId: number | null) => movement({ type: 'TRANSFER', accountId, toAccountId });

  test('origen igual a destino: se quita el destino', () => {
    const r = reviewParsed(transfer(1, 1), context('pasé 20 de Andino a Andino', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, null);
    assert.deepEqual(r.dropped, ['toAccountId']);
  });
  test('"de Andino a Litoral" con un banco cada una: conserva las dos', () => {
    const r = reviewParsed(transfer(1, 3), context('transferí 100 de Andino a Litoral', { amountStats: null, accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, 3);
  });
  test('origen ambiguo y destino claro: solo se quita el origen', () => {
    const r = reviewParsed(transfer(1, 3), context('transferí 100 de Andino a Litoral', { accounts }));
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.toAccountId, 3);
    assert.deepEqual(r.dropped, ['accountId']);
  });
  test('origen claro y destino ambiguo: solo se quita el destino', () => {
    const r = reviewParsed(transfer(3, 2), context('transferí 100 desde Litoral a Andino', { accounts }));
    assert.equal(r.parsed.accountId, 3);
    assert.equal(r.parsed.toAccountId, null);
  });
  test('origen y destino invertidos por la IA: se quitan los dos', () => {
    const r = reviewParsed(transfer(3, 1), context('transferí 100 de Andino a Litoral', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.toAccountId, null);
  });
  test('"a Litoral desde Andino" entiende el orden inverso', () => {
    const r = reviewParsed(transfer(1, 3), context('pasé 100 a Litoral desde Andino', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, 3);
  });
  test('"de ahorros a corriente" dentro del mismo banco', () => {
    const r = reviewParsed(transfer(1, 2), context('pasé 100 de ahorros a corriente en Andino', { accounts }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, 2);
  });
  test('sin origen en el texto: se quita el origen y se conserva el destino', () => {
    const r = reviewParsed(transfer(1, 3), context('pasé 100 a Litoral', { accounts }));
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.toAccountId, 3);
  });
  test('"a la cuenta de Litoral" no se lee como origen', () => {
    const r = reviewParsed(transfer(1, 3), context('transferí 100 de Andino ahorros a la cuenta de Litoral', { accounts }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, 3);
  });
  test('sin preposiciones usa todo el texto excluyendo la otra cuenta', () => {
    const r = reviewParsed(transfer(1, 3), context('transferencia entre Andino y Litoral 100', { accounts: [ANDINO_AH, LITORAL] }));
    assert.equal(r.parsed.accountId, 1);
    assert.equal(r.parsed.toAccountId, 3);
  });
});

describe('monto sin evidencia', () => {
  const unsupported: [string, number, number[]][] = [
    ['alícuota de enero 85', 850, [850, 85]],
    ['arriendo de marzo 1500', 150, [150, 1500]],
    ['pagué recibo 40', 400, [400, 40]],
    ['factura 1500 pagada', 150, [150, 1500]],
    ['gasté 30 en Almacenes Tres Hermanos', 300, [300, 30]],
    ['compré un iphone 15 por 800', 15, [15, 800]],
    ['gasté 20 dolares en 3 cosas', 3, [3, 20]],
    ['gasté 20 dolares en 3 cosas', 60, [60, 20]],
    ['gasté $20 en 3 cosas', 3, [3, 20]],
    ['gasté en cafe', 900, [900]],
    ['pagué factura 123', 900, [900, 123]],
    ['gasté 20 en dos cafés', 200, [200, 20]]
  ];
  for (const [text, amount, offered] of unsupported) {
    test(`"${text}" con ${amount} pregunta`, () => {
      const r = reviewParsed(movement({ amount }), context(text));
      assert.deepEqual(codes(r), ['AMOUNT_UNSUPPORTED']);
      assert.equal(r.issues[0].free, 'amount');
      assert.deepEqual(r.issues[0].options.map((o) => o.patch.amount), offered);
      assert.equal(r.parsed.amount, amount);
    });
  }
  const supported: [string, number][] = [
    ['alícuota de enero 85', 85],
    ['arriendo de marzo 1500', 1500],
    ['pagué recibo 40', 40],
    ['factura 1500 pagada', 1500],
    ['gasté 30 en Almacenes Tres Hermanos', 30],
    ['compré un iphone 15 por 800', 800],
    ['gasté 20 dolares en 3 cosas', 20],
    ['puse 10 galones a 3', 30],
    ['tres mil noventa y ocho en arriendo', 3098],
    ['gasté 20 en dos cafés', 20],
    ['pagué 300 por 2', 300],
    ['taxi $5 y almuerzo 3', 8],
    ['gasté $100 menos $20', 80]
  ];
  for (const [text, amount] of supported) {
    test(`"${text}" con ${amount} no pregunta`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(text))), []);
    });
  }
  test('los últimos 4 no se ofrecen como monto', () => {
    const r = reviewParsed(movement({ amount: 900 }), context('pagué con la 4567'));
    assert.deepEqual(r.issues[0].options.map((o) => o.patch.amount), [900]);
  });
  test('un número suelto repetido no se multiplica por sí mismo', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 400 }), context('gasté 20'))), ['AMOUNT_MISMATCH']);
  });
  test('sin evidencia tampoco se repite como inusual', () => {
    const r = reviewParsed(movement({ amount: 200000 }), context('gasté en cafe'));
    assert.deepEqual(codes(r), ['AMOUNT_UNSUPPORTED']);
  });
});

describe('números en palabras', () => {
  const fits: [string, number][] = [
    ['gasté dos cafés', 2],
    ['tres mil en arriendo', 3000],
    ['mil quinientos de arriendo', 1500],
    ['doscientos veinte de luz', 220],
    ['ciento cincuenta de luz', 150],
    ['veintitrés dólares', 23],
    ['treinta y cinco de gasolina', 35],
    ['dos mil por el terreno', 2000],
    ['un dólar', 1],
    ['un dólar con 50', 1.5],
    ['una cola y un dólar con 50', 1.5],
    ['tres con cincuenta el pasaje', 3.5],
    ['dos cincuenta el pasaje', 2.5],
    ['veinte dólares con cincuenta centavos', 20.5],
    ['cincuenta centavos de caramelos', 0.5],
    ['medio dólar de caramelos', 0.5],
    ['3 mil quinientos de arriendo', 3500],
    ['tres mil 98 de arriendo', 3098],
    ['dos cafés a 3', 6],
    ['gasté 20 y 50', 20.5],
    ['almuerzo 24 50', 24.5]
  ];
  for (const [text, amount] of fits) {
    test(`"${text}" se lee como ${amount}`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(text))), []);
    });
  }
  const asks: [string, number][] = [
    ['tres mil en arriendo', 300],
    ['mil quinientos de arriendo', 15000],
    ['doscientos veinte de luz', 22],
    ['compré un cuaderno', 900]
  ];
  for (const [text, amount] of asks) {
    test(`"${text}" con ${amount} pregunta`, () => {
      assert.deepEqual(codes(reviewParsed(movement({ amount }), context(text))), ['AMOUNT_UNSUPPORTED']);
    });
  }
  test('dos millones coincide y solo se avisa como inusual', () => {
    assert.deepEqual(codes(reviewParsed(movement({ amount: 2000000 }), context('dos millones por el terreno'))), ['AMOUNT_UNUSUAL']);
  });
  test('un artículo no cuenta como número', () => {
    const r = reviewParsed(movement({ amount: 1 }), context('compré un cuaderno'));
    assert.deepEqual(codes(r), ['AMOUNT_UNSUPPORTED']);
  });
  test('una palabra del catálogo de JavaScript no rompe la revisión', () => {
    const r = reviewParsed(movement({ amount: 20 }), context('gasté 20 con el constructor'));
    assert.deepEqual(codes(r), []);
  });
});

describe('cuenta nombrada por casualidad', () => {
  const salary = { id: 50, name: 'Sueldo', bankName: 'Banco Sur', accountKind: null, accountNumber: null };
  const holder = { id: 51, name: 'Pedro Ejemplo', bankName: 'Banco Sur', accountKind: null, accountNumber: null };
  const drops: [string, number, ReviewContext['accounts']][] = [
    ['gasté 15 en un pasaje a Litoral', 3, [ANDINO_AH, LITORAL]],
    ['almuerzo 5 en la Av. Andino', 1, [ANDINO_AH, LITORAL]],
    ['almuerzo 5 en la avenida Andino', 1, [ANDINO_AH, LITORAL]],
    ['almuerzo 5 en la calle Andino', 1, [ANDINO_AH, LITORAL]],
    ['almuerzo 5 en el Norte', 7, [{ id: 7, name: 'Norte', bankName: 'Banco del Norte', accountKind: null, accountNumber: null }]],
    ['pagué el sueldo del empleado 400', 50, [salary, LITORAL]],
    ['pagué a Pedro 20', 51, [holder, LITORAL]],
    ['pasaje de Litoral a Andino 20', 3, [ANDINO_AH, LITORAL]]
  ];
  for (const [text, accountId, accounts] of drops) {
    test(`"${text}" no da base`, () => {
      const r = reviewParsed(movement({ accountId, amount: null }), context(text, { accounts }));
      assert.equal(r.parsed.accountId, null);
      assert.deepEqual(r.dropped, ['accountId']);
    });
  }
  const keeps: [string, number, ParsedMovement['type']][] = [
    ['gasté 20 en el súper con Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper desde Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper de la cuenta Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper por transferencia Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper con débito Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper con tarjeta Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper de mi Andino', 1, 'EXPENSE'],
    ['gasté 20 en el súper del banco Andino', 1, 'EXPENSE'],
    ['gasté 20 Andino', 1, 'EXPENSE'],
    ['Andino 20 almuerzo', 1, 'EXPENSE'],
    ['deposité 20 en Andino', 1, 'INCOME'],
    ['me pagaron 20 en Andino', 1, 'INCOME'],
    ['retiré 20 en Andino', 1, 'WITHDRAWAL']
  ];
  for (const [text, accountId, type] of keeps) {
    test(`"${text}" da base`, () => {
      const r = reviewParsed(movement({ accountId, type, amount: null }), context(text));
      assert.equal(r.parsed.accountId, accountId);
      assert.deepEqual(r.dropped, []);
    });
  }
  test('un destino casual no empata con la cuenta usada', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('pagué 20 al Litoral con Andino'));
    assert.equal(r.parsed.accountId, 1);
  });
  test('la segunda palabra del nombre cuenta junto a la primera', () => {
    const accounts = [
      { id: 60, name: 'Sur Negocio', bankName: 'Banco Sur', accountKind: null, accountNumber: null },
      { id: 61, name: 'Sur Personal', bankName: 'Banco Sur', accountKind: null, accountNumber: null }
    ];
    assert.equal(reviewParsed(movement({ accountId: 60 }), context('gasté 20 en el súper con Sur negocio', { accounts })).parsed.accountId, 60);
  });
  test('"pagué la visa" sigue nombrando la tarjeta', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué la visa 20')).parsed.cardId, 10);
  });
  test('"pagué 20 a la visa" y "abono a la visa 20" nombran la tarjeta', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('pagué 20 a la visa')).parsed.cardId, 10);
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('abono a la visa 20')).parsed.cardId, 10);
  });
  test('"gasté 20 en un pasaje a Visa" no nombra la tarjeta', () => {
    assert.equal(reviewParsed(movement({ cardId: 10 }), context('gasté 20 en un pasaje a Visa')).parsed.cardId, null);
  });
  test('en una transferencia el destino no necesita indicio de pago', () => {
    const r = reviewParsed(movement({ type: 'TRANSFER', accountId: 1, toAccountId: 3 }), context('pasé 20 de Andino a Litoral'));
    assert.equal(r.parsed.toAccountId, 3);
  });
});

describe('tipo de la IA', () => {
  for (const type of ['INCOME', 'EXPENSE', 'PURCHASE', 'TRANSFER', 'WITHDRAWAL'] as const) {
    test(`${type} se conserva`, () => {
      const r = reviewParsed(movement({ type }), context('gasté 20'));
      assert.equal(r.parsed.type, type);
      assert.ok(!r.dropped.includes('type'));
    });
  }
  for (const bad of ['ADJUSTMENT', 'expense', 'OTRO', '', 7]) {
    test(`${JSON.stringify(bad)} se quita`, () => {
      const r = reviewParsed(movement({ type: bad as unknown as ParsedMovement['type'] }), context('gasté 20'));
      assert.equal(r.parsed.type, null);
      assert.deepEqual(r.dropped, ['type']);
    });
  }
  test('nulo no se registra como quitado', () => {
    const r = reviewParsed(movement({ type: null }), context('gasté 20'));
    assert.equal(r.parsed.type, null);
    assert.deepEqual(r.dropped, []);
  });
});

describe('coste', () => {
  const size = 65536;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const hostile: [string, string][] = [
    ['1.1.1.…', fill('1.')],
    ['dígitos', fill('7')],
    ['****…', fill('*')],
    ['a la de la de…', fill('a la de la de ')],
    ['xxxx…', fill('x')],
    ['7 7 7…', fill('7 ')],
    ['dos dos dos…', fill('dos ')],
    ['1234.1234.…', fill('1234.')],
    ['$1 $1 $1…', fill('$1 ')]
  ];
  const accounts = [ANDINO_AH, ANDINO_CO, LITORAL];
  for (const [name, text] of hostile) {
    for (const type of ['EXPENSE', 'TRANSFER'] as const) {
      test(`${name} (${type}) tarda menos de 100 ms`, () => {
        const started = performance.now();
        reviewParsed(movement({ type, amount: 999, accountId: 1, toAccountId: type === 'TRANSFER' ? 3 : null, cardId: 10 }), context(text, { accounts }));
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 100, `tardó ${elapsed.toFixed(1)} ms`);
      });
    }
  }
  test('lo que pasa de 2.000 caracteres no se lee', () => {
    const within = `gasté 20 con Andino ${'x'.repeat(1900)}`;
    assert.equal(reviewParsed(movement({ amount: 20, accountId: 1 }), context(within)).parsed.accountId, 1);
    const beyond = `gasté 20 ${'x'.repeat(2000)} con Andino`;
    assert.equal(reviewParsed(movement({ amount: 20, accountId: 1 }), context(beyond)).parsed.accountId, null);
  });
});

describe('efectivo y coherencia', () => {
  test('CASH sin mención no se toca', () => {
    const r = reviewParsed(movement({ paymentMethod: 'CASH' }), context('gasté 20 en el súper'));
    assert.equal(r.parsed.paymentMethod, 'CASH');
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.issues, []);
  });
  test('los demás campos pasan intactos', () => {
    const r = reviewParsed(movement({ vendor: 'Tienda', notes: 'nota', bankHint: 'Andino', accountId: 3 }), context('gasté 20 con Andino'));
    assert.equal(r.parsed.vendor, 'Tienda');
    assert.equal(r.parsed.notes, 'nota');
    assert.equal(r.parsed.bankHint, 'Andino');
  });
});

describe('casos normales sin issue ni datos quitados', () => {
  const accounts = [ANDINO_AH, LITORAL];
  const cases: { text: string; over: Partial<ParsedMovement>; ctx?: Partial<ReviewContext> }[] = [
    { text: 'gasté 20 en el súper', over: {} },
    { text: 'gasté 20 en el súper con Andino', over: { accountId: 1 } },
    { text: 'almuerzo 3,50', over: { amount: 3.5 } },
    { text: 'almuerzo 3.50 en efectivo', over: { amount: 3.5, paymentMethod: 'CASH' } },
    { text: 'taxi $5', over: { amount: 5 } },
    { text: 'ingreso de 800 por sueldo', over: { type: 'INCOME', amount: 800 } },
    { text: 'me pagaron 1.200,50 de sueldo en Litoral', over: { type: 'INCOME', amount: 1200.5, accountId: 3 } },
    { text: 'retiré 50 de Andino', over: { type: 'WITHDRAWAL', amount: 50, accountId: 1 } },
    { text: 'retiré 50 de la cuenta de ahorros de Litoral', over: { type: 'WITHDRAWAL', amount: 50, accountId: 3 } },
    { text: 'compré 2 cafés a 3', over: { type: 'PURCHASE', amount: 6 } },
    { text: '3 cuadernos a 2 dólares', over: { type: 'PURCHASE', amount: 6 } },
    { text: '5 galones de gasolina a 3 dólares', over: { amount: 15 } },
    { text: 'taxi 5 y almuerzo 3', over: { amount: 8 } },
    { text: 'gasté 3 mil en el carro', over: { amount: 3000 } },
    { text: 'gasté 3 mil 98 en arriendo', over: { amount: 3098 } },
    { text: 'gasté 20 mil en el carro', over: { amount: 20000 } },
    { text: 'mil 500 de arriendo', over: { amount: 1500 } },
    { text: 'gasté 20k en el carro', over: { amount: 20000 } },
    { text: 'café 2 dólares con 50 centavos', over: { amount: 2.5 } },
    { text: 'café 2 dólares 50', over: { amount: 2.5 } },
    { text: 'chicle 50 centavos', over: { amount: 0.5 } },
    { text: 'almuerzo 3 con 50', over: { amount: 3.5 } },
    { text: 'pasaje 3 y medio', over: { amount: 3.5 } },
    { text: 'compré un iphone 15 a mil doscientos', over: { type: 'PURCHASE', amount: 1200 } },
    { text: 'gasolina súper 95 por 20', over: { amount: 20 } },
    { text: 'aceite 20w50 por 18', over: { amount: 18 } },
    { text: 'plan de 10 gb por 15', over: { amount: 15 } },
    { text: 'pagué 300 a 12 cuotas', over: { amount: 300 } },
    { text: '12 cuotas de 50', over: { amount: 600 } },
    { text: 'factura 001-002-000123456 de 45,30', over: { amount: 45.3 } },
    { text: 'pagué 20 con la visa', over: { cardId: 10, paymentMethod: 'CREDIT_CARD' } },
    { text: 'gasté 20 con la mastercard', over: { cardId: 11, paymentMethod: 'CREDIT_CARD' } },
    { text: 'pagué 20 con la tarjeta 9876', over: { cardId: 10, paymentMethod: 'CREDIT_CARD' } },
    { text: 'pagué 20 con ****9876', over: { cardId: 10, paymentMethod: 'CREDIT_CARD' } },
    { text: 'pagué 20 con la 4567', over: { accountId: 1 } },
    { text: 'pagué 4567 con la 4567', over: { amount: 4567, accountId: 1 } },
    { text: 'pagué 20 el 5 de noviembre', over: { date: '2026-11-05', amount: 20 }, ctx: { today: '2026-11-06' } },
    { text: 'ayer pagué 20 de luz', over: { date: '2026-11-02', categoryId: 100, categoryCandidates: [100, 101] } },
    { text: 'veinte dólares en el súper', over: {} },
    { text: 'tres mil noventa y ocho en arriendo', over: { amount: 3098 } },
    { text: 'dos cafés por 3', over: { amount: 3 } },
    { text: 'gasté 20 de mi cuenta', over: { accountId: 1 }, ctx: { accounts: [ANDINO_AH] } },
    { text: 'con mi cuenta de ahorros pagué 20', over: { accountId: 1 }, ctx: { accounts: [ANDINO_AH, ANDINO_CO] } },
    { text: 'pagué 20 por transferencia', over: { accountId: 1, paymentMethod: 'BANK_TRANSFER' }, ctx: { accounts: [ANDINO_AH] } },
    { text: 'pagué 20 con débito', over: { accountId: 1, paymentMethod: 'DEBIT_CARD' }, ctx: { accounts: [ANDINO_AH] } },
    { text: 'gasté $1,500.00 en el carro', over: { amount: 1500 } },
    { text: 'gasté 1.500 con el 15% de iva', over: { amount: 1500 } },
    { text: 'pagué 80 de internet, celular 0991234567', over: { amount: 80 } },
    { text: 'gasté 20 hoy a las 5 de la tarde', over: {} },
    { text: 'gasté 20 hace 3 días', over: {} },
    { text: 'gasté 100 menos 20 de descuento', over: { amount: 80 } },
    { text: 'pagué con 50 y me dieron 12 de vuelto', over: { amount: 38 } },
    { text: 'sueldo de octubre 800', over: { type: 'INCOME', amount: 800 } },
    { text: 'almuerzo en la 10 de agosto 4,50', over: { amount: 4.5 } },
    { text: 'gasté 3 098 en arriendo', over: { amount: 3098 } },
    { text: '.50 de caramelos', over: { amount: 0.5 } }
  ];
  for (const { text, over, ctx } of cases) {
    test(`"${text}"`, () => {
      const p = movement(over);
      const r = reviewParsed(p, context(text, { accounts, ...ctx }));
      assert.deepEqual(r.issues, []);
      assert.deepEqual(r.dropped, []);
      assert.deepEqual(r.parsed, p);
    });
  }
});

describe('entradas raras', () => {
  test('todo nulo no lanza ni pregunta', () => {
    const p = movement({ amount: null, date: null, type: null, paymentMethod: null });
    const r = reviewParsed(p, context(''));
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.parsed, p);
  });
  test('claves omitidas por la IA se tratan como nulas', () => {
    const p = { understood: true, intent: 'register' } as unknown as ParsedMovement;
    const r = reviewParsed(p, context('gasté 20'));
    assert.deepEqual(r.issues, []);
    assert.equal(r.parsed.accountId, null);
  });
  test('texto vacío: sin base se quita la cuenta y no hay pregunta de monto', () => {
    const r = reviewParsed(movement({ accountId: 1, cardId: 10 }), context(''));
    assert.equal(r.parsed.accountId, null);
    assert.equal(r.parsed.cardId, null);
    assert.deepEqual(r.issues, []);
  });
  test('texto nulo y catálogos ausentes no lanzan', () => {
    const r = reviewParsed(movement({ accountId: 1 }), { text: null, today: null } as unknown as ReviewContext);
    assert.equal(r.parsed.accountId, null);
    assert.deepEqual(r.issues, []);
  });
  test('catálogo con nulos en nombres y dígitos', () => {
    const accounts = [{ id: 1, name: null as unknown as string, bankName: null, accountKind: null, accountNumber: null }];
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20', { accounts, cards: [] }));
    assert.equal(r.parsed.accountId, null);
  });
  test('una entrada del catálogo que rompe la revisión no lanza', () => {
    const r = reviewParsed(movement({ accountId: 1 }), context('gasté 20', { accounts: [null as never] }));
    assert.equal(r.parsed.accountId, 1);
    assert.deepEqual(r.issues, []);
  });
  test('categoryCandidates que no es arreglo queda vacío', () => {
    const r = reviewParsed(movement({ categoryCandidates: 'x' as unknown as number[] }), context('gasté 20'));
    assert.deepEqual(r.parsed.categoryCandidates, []);
  });
  test('hoy inválido no impide revisar lo demás', () => {
    const r = reviewParsed(movement({ date: '2020-01-01', amount: -1 }), context('gasté 20', { today: 'mal' }));
    assert.equal(r.parsed.date, '2020-01-01');
    assert.equal(r.parsed.amount, null);
    assert.deepEqual(r.issues, []);
  });
  test('no muta la entrada', () => {
    const p = movement({ accountId: 99, toAccountId: 98, cardId: 97, categoryId: 96, categoryCandidates: [100, 555], amount: -1, date: 'mal', accountName: 'X' });
    const copy = structuredClone(p);
    const ctx = context('gasté 20');
    const ctxCopy = structuredClone(ctx);
    const r = reviewParsed(p, ctx);
    assert.deepEqual(p, copy);
    assert.deepEqual(ctx, ctxCopy);
    assert.notEqual(r.parsed, p);
    assert.notEqual(r.parsed.categoryCandidates, p.categoryCandidates);
  });
});
