<template>
  <div class="toast-container">
    <Transition name="toast">
      <div v-if="show" class="toast" :class="type">
        {{ message }}
      </div>
    </Transition>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  message: string;
  type?: 'error' | 'info';
  duration?: number;
}>();

const show = ref(false);
let timeout: number;

onMounted(() => {
  show.value = true;
  timeout = window.setTimeout(() => {
    show.value = false;
  }, props.duration || 3000);
});

onUnmounted(() => {
  clearTimeout(timeout);
});
</script>

<style scoped>
.toast-container {
  position: fixed;
  right: 24px;
  bottom: 24px;
  left: 24px;
  z-index: 9999;
}

.toast {
  width: max-content;
  background: rgba(255, 255, 255, 0.9);
  color: black;
  padding: 12px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-family: 'Roboto', sans-serif;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
}

.toast.error {
  color: #ff003e;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}
</style>
