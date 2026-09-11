<script setup lang="ts">
import type { GeneratedLevel } from '@/core/generation'

defineProps<{
  level: GeneratedLevel | null
}>()
</script>

<template>
  <div v-if="level" class="level-info">
    <div class="info-row"><span>Rooms:</span> <strong>{{ level.rooms.length }}</strong></div>
    <div class="info-row"><span>Corridors:</span> <strong>{{ level.corridors.length }}</strong></div>
    <div class="info-row"><span>Stairs:</span> <strong>{{ level.stairs.length }}</strong></div>
    <div class="info-row"><span>Floors:</span> <strong>{{ level.config.floorCount }}</strong></div>
    <div class="info-row"><span>Seed:</span> <strong>{{ level.seed }}</strong></div>
  </div>
</template>

<style scoped>
.level-info {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.75rem;
}

.info-row {
  display: flex;
  justify-content: space-between;
}
</style>
