import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  site: 'https://kingshot.wooju-home.org',
  output: 'static',
  trailingSlash: 'always',
  markdown: {
    // Astro 의 자동 GFM 비활성화 → remark-gfm 을 명시적으로 추가해 옵션 제어.
    // 목적: singleTilde: false — `1~6` 같은 single tilde 가 strikethrough 로
    // 잘못 해석되는 문제 차단 (가이드 본문에서 숫자 범위 표기 빈도 높음).
    // GFM 의 다른 기능 (table / autolink / tasklist) 은 remark-gfm 으로 그대로 유지.
    gfm: false,
    remarkPlugins: [
      [remarkGfm, { singleTilde: false }],
      // CJK 환경에서 CommonMark 의 left/right-flanking 규칙이 한국어 조사·괄호와
      // 충돌해 `**텍스트(부가)**조사` 형태가 강조되지 않는 문제를 해결한다.
      remarkCjkFriendly,
    ],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
