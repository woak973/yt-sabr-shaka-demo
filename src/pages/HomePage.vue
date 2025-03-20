<style scoped>
.home {
  padding: 20px;
}

.input-container {
  margin-top: 20px;
}

input {
  padding: 8px 12px;
  font-size: 16px;
  margin-right: 10px;
  background: #333;
  border: 1px solid #444;
  color: white;
  border-radius: 4px;
}

button {
  padding: 8px 16px;
  font-size: 16px;
  background: #3ea6ff;
  border: none;
  color: black;
  border-radius: 4px;
  cursor: pointer;
}

button:hover {
  background: #65b8ff;
}

.search-container {
  margin-top: 20px;
  position: relative;
  width: 100%;
  max-width: 600px;
}

.search-results {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: #242424;
  border: 1px solid #444;
  border-radius: 4px;
  margin-top: 4px;
  max-height: 400px;
  overflow-y: auto;
}

.search-result-item {
  display: flex;
  padding: 10px;
  cursor: pointer;
  border-bottom: 1px solid #444;
}

.search-result-item:hover {
  background: #333;
}

.thumbnail-container {
  width: 120px;
  height: 67px;
  margin-right: 10px;
  background: #1a1a1a;
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}

.thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #1a1a1a;
  transition: opacity 0.2s;
}

.video-info {
  flex: 1;
}

.title {
  font-size: 14px;
  margin-bottom: 4px;
  color: white;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.2;
}

.channel {
  font-size: 12px;
  color: #aaa;
}
</style>

<template>
  <div class="home">
    <div class="input-container">
      <input v-model="videoId" placeholder="Enter YouTube Video ID" @keyup.enter="watchVideo">
      <button @click="watchVideo">Watch</button>
    </div>
    <div class="search-container">
      <input v-model="searchQuery" placeholder="Search videos..." @input="handleSearch">
      <div v-if="searchResults.length" class="search-results">
        <div v-for="result in searchResults" :key="result.id" class="search-result-item"
          @click="selectVideo(result.id)">
          <div class="thumbnail-container">
            <img :src="result.thumbnail" class="thumbnail" :alt="result.title" loading="lazy"
              @error="handleImageError($event.target as any)" />
          </div>
          <div class="video-info">
            <div class="title">{{ result.title }}</div>
            <div class="channel">{{ result.channel }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useInnertube } from '../composables/useInnertube';
import { useDebounce } from '../composables/useDebounce';
import { YTNodes } from 'youtubei.js/web';

const router = useRouter();
const videoId = ref('');
const searchQuery = ref('');
const searchResults = ref<Array<{ id: string; title: string; channel: string; thumbnail: string }>>([]);
const getInnertube = useInnertube();

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

function watchVideo() {
  if (videoId.value) {
    router.push(`/watch/${videoId.value}`);
  }
}

const performSearch = async () => {
  if (!searchQuery.value.length) {
    searchResults.value = [];
    return;
  }

  const innertube = await getInnertube();
  const search = await innertube.actions.execute('/search', { query: searchQuery.value, parse: true });

  if (!search.contents_memo) {
    searchResults.value = [];
    return;
  }

  const results = search.contents_memo?.getType(YTNodes.Video, YTNodes.CompactVideo);

  if (results) {
    searchResults.value = results.map((result) => ({
      id: result.id,
      title: result.title.toString(),
      channel: result.author?.name || 'Unknown',
      thumbnail: result.thumbnails[0].url
    }));
  } else {
    searchResults.value = [];
  }
};

const handleSearch = useDebounce(performSearch, 300);

onUnmounted(() => {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
});

function selectVideo(id: string) {
  videoId.value = id;
  watchVideo();
}

function handleImageError(img: HTMLImageElement) {
  img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"%3E%3C/svg%3E';
}
</script>