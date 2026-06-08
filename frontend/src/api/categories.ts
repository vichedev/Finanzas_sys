import { createResource } from './resource';
import type { Category } from '../types';

export const categoriesApi = createResource<Category, Partial<Category>>('/categories');
