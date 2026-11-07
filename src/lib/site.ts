import { getCollection } from 'astro:content';

export type Language = 'zh' | 'en';

export const content = {
  about: { zh: '', en: '' },
  projects: [] as { name: string; description: Record<Language, string>; url: string }[],
};

export const labels = {
  zh: { articles: '文章', about: '關於', projects: '作品', back: '返回文章', language: 'English' },
  en: { articles: 'Writing', about: 'About', projects: 'Work', back: 'Back to writing', language: '繁體中文' },
};

export const url = (path = '') => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path}`;

export async function posts() {
  return (await getCollection('blog', ({ data }) => !data.draft))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
