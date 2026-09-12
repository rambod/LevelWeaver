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
    <div class="info-row"><span>Wall:</span> <strong>{{ level.config.wallHeight.toFixed(1) }} m</strong></div>
    <div class="info-row"><span>Gate:</span> <strong>{{ level.config.doorWidth.toFixed(1) }} × {{ level.config.doorHeight.toFixed(1) }} m</strong></div>
    <div class="info-row"><span>Seed:</span> <strong>{{ level.seed }}</strong></div>
    <div v-if="level.validation && level.validation.errors.length > 0" class="info-row issues">
      <span>Issues:</span> <strong>{{ level.validation.errors.length }} error(s)</strong>
    </div>
    <div v-for="issue in (level.validation ? level.validation.errors.slice(0, 4) : [])" :key="issue.code + issue.message" class="issue">
      [{{ issue.code }}] {{ issue.message }}
    </div>
    <div v-if="level.validation && level.validation.errors.length === 0 && level.validation.warnings.length > 0" class="info-row warnings">
      <span>Notes:</span> <strong>{{ level.validation.warnings.length }} warning(s)</strong>
    </div>
    <div v-for="issue in (level.validation && level.validation.errors.length === 0 ? level.validation.warnings.slice(0, 2) : [])" :key="issue.code + issue.message" class="issue warning">
      [{{ issue.code }}] {{ issue.message }}
    </div>
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

.info-row.issues {
  color: #ff8888;
}

.info-row.warnings {
  color: #ffcc66;
}

.issue {
  font-size: 0.7rem;
  color: #ff8888;
  line-height: 1.35;
}

.issue.warning {
  color: #ffcc66;
}
</style>
