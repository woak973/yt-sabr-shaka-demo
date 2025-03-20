import { createRouter, createWebHistory } from 'vue-router';
import HomePage from './pages/HomePage.vue';
import WatchPage from './pages/WatchPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: HomePage
    },
    {
      path: '/watch/:id',
      component: WatchPage
    }
  ]
});
