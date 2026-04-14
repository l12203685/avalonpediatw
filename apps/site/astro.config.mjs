import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwind from '@astrojs/tailwind';
import pagefind from 'astro-pagefind';

export default defineConfig({
  site: 'https://avalonpediatw.pages.dev',
  integrations: [mdx(), tailwind(), pagefind()],
  build: { format: 'directory' },
  markdown: { shikiConfig: { theme: 'github-dark' } }
});
