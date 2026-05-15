import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import obfuscator from 'vite-plugin-javascript-obfuscator';

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
    plugins: [
      tailwindcss(),
      // 클라이언트 번들 Low 난독화 — production build 만 적용 (dev/HMR 영향 없음).
      // 효과: 변수명 hex + 문자열 array (base64) 추출 → endpoint/상수가 첫눈에 안 읽힘.
      // 비활성: control-flow flattening / dead code injection / self-defending — 번들 크기 + 런타임 영향 ↑.
      // 진짜 보호는 서버측 (Edge Function + RLS) 이 담당. 이 설정은 "탭 열어서 바로 읽힘" 만 차단.
      obfuscator({
        apply: 'build',
        // node_modules 는 그대로 두기 — Astro 런타임 internal + WASM(@jsquash) 깨질 위험 차단.
        // exclude 패턴은 plugin 의 micromatch 형식.
        exclude: [/node_modules/],
        options: {
          compact: true,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          stringArray: true,
          stringArrayEncoding: ['base64'],
          stringArrayThreshold: 1,
          // 비용 큰 옵션 전부 off (Low 강도 약속)
          controlFlowFlattening: false,
          deadCodeInjection: false,
          debugProtection: false,
          disableConsoleOutput: false,
          selfDefending: false,
          splitStrings: false,
          unicodeEscapeSequence: false,
          numbersToExpressions: false,
          simplify: true,
        },
      }),
    ],
  },
});
