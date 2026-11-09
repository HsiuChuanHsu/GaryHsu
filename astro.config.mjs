import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import sectionRows from './src/lib/section-rows.mjs';

export default defineConfig({
  site: 'https://HsiuChuanHsu.github.io',
  base: '/GaryHsu',
  markdown: { processor: satteri({ hastPlugins: [sectionRows] }) },
});
