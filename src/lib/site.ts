import { getCollection, type CollectionEntry } from 'astro:content';

export type Language = 'zh' | 'en';
export type Category = CollectionEntry<'blog'>['data']['category'];

export const categoryLabels = { work: 'Work', personal: 'Personal' };

export const content = {
  about: { zh: '', en: '' },
  projects: [] as { name: string; description: Record<Language, string>; url: string }[],
};

export const labels = {
  zh: { posts: 'Posts', about: '關於', projects: '作品', back: 'Back to Posts', language: 'English', postsIntro: '工作實務與個人探索的紀錄', categories: '文章分類', empty: '這個分類還沒有文章。', typeEmpty: '這個類型還沒有文章。' },
  en: { posts: 'Posts', about: 'About', projects: 'Work', back: 'Back to Posts', language: '繁體中文', postsIntro: 'Notes on work and personal explorations.', categories: 'Post categories', empty: 'No posts in this category yet.', typeEmpty: 'No posts of this type yet.' },
};

export const url = (path = '') => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path}`;

export async function posts(category?: Category) {
  return (await getCollection('blog', ({ data }) => !data.draft && (!category || data.category === category)))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
