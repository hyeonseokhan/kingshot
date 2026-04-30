/**
 * 가벼운 reactive store — 페이지 간 공유 데이터의 단일 출처.
 *
 * 트랙 1 깜박임 제거의 기반. 각 페이지가 독립적으로 fetch + 모듈 변수에 보관하던 패턴을
 * 하나의 store 로 모아서:
 *   - 페이지 이동/재진입 시 캐시 즉시 반영 (스켈레톤 단계 단축)
 *   - 갱신은 모든 구독자에게 자동 전파 (custom event 수동 dispatch 불필요)
 *   - sessionStorage 백업으로 새로고침에서도 캐시 유지
 *
 * 사용:
 *   const store = createStore<Member[]>({ storageKey: 'members_v1', ttlMs: 60_000 });
 *   const unsub = store.subscribe((value) => render(value));   // 즉시 1회 + 변경 시마다
 *   store.refresh(() => fetchMembers());                       // in-flight 중복 호출 방지
 *   store.invalidate();                                        // 캐시 비움 + 구독자에게 null
 */

export interface Store<T> {
  /** 현재 값 — 캐시 미스 + 만료 시 null. */
  get(): T | null;
  /** 새 값 저장 + 모든 구독자에게 알림 + sessionStorage 백업. */
  set(value: T): void;
  /**
   * 구독. 콜백은 즉시 1회 (현재 값으로) 호출되고, 이후 set/invalidate 시마다 호출.
   * 반환값은 unsubscribe 함수.
   */
  subscribe(cb: (value: T | null) => void): () => void;
  /** 캐시 + 메모리 값 비움. 구독자에게 null 알림. */
  invalidate(): void;
  /**
   * fetcher 를 실행해 값을 갱신. 같은 fetcher 가 진행 중이면 그 Promise 를 반환
   * (중복 호출 방지). 성공 시 set() 호출 → 구독자 자동 갱신.
   */
  refresh(fetcher: () => Promise<T>): Promise<T>;
}

export interface CreateStoreOptions<T> {
  /** sessionStorage 백업 키. 미지정 시 메모리 only. */
  storageKey?: string;
  /** 백업 TTL — set 시점부터 ms. 만료 시 get() 이 null. 미지정 시 무한. */
  ttlMs?: number;
  /**
   * sessionStorage 에서 복원 시 타입 검증. false 반환 시 캐시 무시.
   * 미지정 시 raw 그대로 신뢰.
   */
  validate?: (raw: unknown) => boolean;
}

interface CachedEntry<T> {
  value: T;
  ts: number;
}

export function createStore<T>(opts: CreateStoreOptions<T> = {}): Store<T> {
  const { storageKey, ttlMs, validate } = opts;

  // 메모리 + sessionStorage 백업 동기화
  let memory: T | null = readFromStorage();
  const subscribers = new Set<(value: T | null) => void>();
  let inFlight: Promise<T> | null = null;

  function readFromStorage(): T | null {
    if (!storageKey || typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedEntry<T>;
      if (ttlMs != null && Date.now() - parsed.ts > ttlMs) return null;
      if (validate && !validate(parsed.value)) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  function writeToStorage(value: T): void {
    if (!storageKey || typeof sessionStorage === 'undefined') return;
    try {
      const entry: CachedEntry<T> = { value, ts: Date.now() };
      sessionStorage.setItem(storageKey, JSON.stringify(entry));
    } catch {
      /* quota / disabled */
    }
  }

  function clearStorage(): void {
    if (!storageKey || typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* */
    }
  }

  function notify(value: T | null): void {
    for (const cb of subscribers) {
      try {
        cb(value);
      } catch (err) {
        console.error('[store] subscriber error:', err);
      }
    }
  }

  return {
    get() {
      return memory;
    },
    set(value: T) {
      memory = value;
      writeToStorage(value);
      notify(value);
    },
    subscribe(cb) {
      subscribers.add(cb);
      // 즉시 1회 호출 — 캐시가 있으면 페이지가 바로 렌더 가능
      try {
        cb(memory);
      } catch (err) {
        console.error('[store] subscriber init error:', err);
      }
      return () => {
        subscribers.delete(cb);
      };
    },
    invalidate() {
      memory = null;
      clearStorage();
      notify(null);
    },
    refresh(fetcher) {
      if (inFlight) return inFlight;
      inFlight = fetcher()
        .then((value) => {
          memory = value;
          writeToStorage(value);
          notify(value);
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
