import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import remarkCjkFriendly from 'remark-cjk-friendly';

export default defineConfig({
  site: 'https://kingshot.wooju-home.org',
  output: 'static',
  trailingSlash: 'always',
  markdown: {
    // CJK 환경에서 CommonMark 의 left/right-flanking 규칙이 한국어 조사·괄호와
    // 충돌해 `**텍스트(부가)**조사` 형태가 강조되지 않는 문제를 해결한다.
    // 원본 kramdown(허용적) → CommonMark(엄격) 회귀를 보정.
    remarkPlugins: [remarkCjkFriendly],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
