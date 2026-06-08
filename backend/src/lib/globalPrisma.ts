import './env';
import { PrismaClient } from '.prisma/global';

export const globalPrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error']
});
