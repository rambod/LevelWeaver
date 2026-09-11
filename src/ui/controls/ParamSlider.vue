<script setup lang="ts">
defineProps<{
  label: string
  modelValue: number
  min: number
  max: number
  step: number
}>()

defineEmits<{
  (e: 'update:modelValue', value: number): void
  (e: 'change'): void
}>()

function format(value: number, step: number): string {
  const decimals = step < 1 ? 2 : 0
  return value.toFixed(decimals)
}
</script>

<template>
  <div class="panel-section">
    <label class="label">{{ label }}</label>
    <input
      type="range"
      class="slider"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
      @change="$emit('change')"
    />
    <span class="value">{{ format(modelValue, step) }}</span>
  </div>
</template>

<style scoped>
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-section label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8899aa;
}

.slider {
  width: 100%;
  accent-color: #00ff88;
}

.value {
  font-size: 0.75rem;
  color: #8899aa;
  text-align: right;
}
</style>
