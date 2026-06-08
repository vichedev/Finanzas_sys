<script setup lang="ts" generic="T extends { id: number | string }">
// Tabla de datos con configuración de columnas + slots por celda.
// En escritorio: tabla .recent-table. En móvil (<=600px): tarjetas.
import type { Component } from 'vue';
import EmptyState from './EmptyState.vue';

export interface Column<R = any> {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  width?: string;
}

const props = defineProps<{
  columns: Column<T>[];
  rows: T[];
  rowKey?: keyof T;
  empty?: { icon?: Component; title: string; text?: string };
}>();

defineSlots<{
  [key: `cell-${string}`]: (props: { row: T }) => any;
  actions?: (props: { row: T }) => any;
}>();

const keyOf = (row: T): string | number => row[props.rowKey ?? ('id' as keyof T)] as string | number;
const alignClass = (c: Column<T>) => (c.align === 'center' ? 'center' : c.align === 'right' ? 'right' : '');
</script>

<template>
  <div class="data-table">
    <!-- Escritorio -->
    <div class="table-scroll dt-table">
      <table class="recent-table">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.key"
              :class="alignClass(c)"
              :style="c.width ? { width: c.width } : undefined"
            >
              {{ c.label }}
            </th>
            <th v-if="$slots.actions" class="center">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + ($slots.actions ? 1 : 0)">
              <EmptyState v-if="empty" v-bind="empty" />
              <div v-else class="empty">Sin datos.</div>
            </td>
          </tr>
          <tr v-for="row in rows" :key="keyOf(row)">
            <td v-for="c in columns" :key="c.key" :class="alignClass(c)">
              <slot :name="`cell-${c.key}`" :row="row">{{ (row as any)[c.key] }}</slot>
            </td>
            <td v-if="$slots.actions" class="center">
              <div class="row-actions" style="justify-content: center">
                <slot name="actions" :row="row" />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Móvil: tarjetas -->
    <div class="dt-cards">
      <EmptyState v-if="!rows.length && empty" v-bind="empty" />
      <article v-for="row in rows" :key="'c-' + keyOf(row)" class="dt-card">
        <div v-for="c in columns" :key="c.key" class="dt-card-row">
          <span class="dt-card-label">{{ c.label }}</span>
          <span class="dt-card-val">
            <slot :name="`cell-${c.key}`" :row="row">{{ (row as any)[c.key] }}</slot>
          </span>
        </div>
        <div v-if="$slots.actions" class="dt-card-acts row-actions">
          <slot name="actions" :row="row" />
        </div>
      </article>
    </div>
  </div>
</template>
