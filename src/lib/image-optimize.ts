/**
 * 클라이언트 측 이미지 최적화 헬퍼.
 *
 * 사용 사례: 사용자가 폰에서 캡처한 큰 PNG/JPEG (2~6 MB) 를 업로드 전에
 * Canvas API 로 resize + WebP 인코딩 → 평균 ~100 KB 로 축소.
 *
 * 권장 옵션 (블랙리스트 evidence 기준, 2026-05-12 샘플 검증):
 *   - maxWidth 1080
 *   - quality 0.80
 *   - format 'image/webp'
 *
 * 검증 결과: 1179×2556 게임 캡처(1.04 MB PNG) → 92 KB WebP (91% 감소).
 */

export interface OptimizeOptions {
  maxWidth?: number;       // 기본 1080. 원본이 더 작으면 enlarge 안 함
  quality?: number;        // 0.0 ~ 1.0, 기본 0.80
  mimeType?: 'image/webp' | 'image/jpeg';  // 기본 webp
}

export interface OptimizeResult {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}

const DEFAULT_OPTIONS: Required<OptimizeOptions> = {
  maxWidth: 1080,
  quality: 0.80,
  mimeType: 'image/webp',
};

/**
 * File 또는 Blob 을 받아 resize + WebP 변환된 Blob 반환.
 * 실패 시 throw.
 */
export async function optimizeImage(
  source: File | Blob,
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 1) Image 디코드
  const img = await loadImage(source);

  // 2) Canvas 에 그리기 (필요 시 resize)
  const targetWidth = Math.min(img.naturalWidth, opts.maxWidth);
  const scale = targetWidth / img.naturalWidth;
  const targetHeight = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // 3) Blob 인코딩
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      opts.mimeType,
      opts.quality,
    );
  });

  return {
    blob,
    width: targetWidth,
    height: targetHeight,
    bytes: blob.size,
    mimeType: opts.mimeType,
  };
}

function loadImage(source: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

/** "1.04 MB", "92 KB" 식 사람용 표시. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}
