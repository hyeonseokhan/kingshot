"""OCR 닉네임 → DB 닉네임 fuzzy 매칭.

전략:
  1. 정규화 — lowercase + 양끝 특수문자/공백 strip + 내부 공백 단일화
  2. 가변 임계값 — 짧은 닉네임은 엄격 (오매칭 위험), 긴 닉네임은 관대
     - len ≤ 4: exact (1.0) — "Bai" / "Rai" 같은 한 글자 차이 차단
     - len 5~9: 0.80
     - len 10+: 0.85
  3. score 계산 — difflib.SequenceMatcher (stdlib, rapidfuzz 미설치)
  4. top3 후보 항상 함께 반환 — 매칭 실패 시 사용자 검수에 활용
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

_NORMALIZE_STRIP_RE = re.compile(r"^[\W_]+|[\W_]+$")
_NORMALIZE_SPACE_RE = re.compile(r"\s+")


def normalize(name: str) -> str:
    """매칭용 정규화 — lowercase + 양끝 특수문자 제거 + 내부 공백 단일화."""
    if not name:
        return ""
    s = name.strip().lower()
    s = _NORMALIZE_STRIP_RE.sub("", s)  # "'ssungbi" → "ssungbi"
    s = _NORMALIZE_SPACE_RE.sub(" ", s)  # 다중 공백 → 단일
    return s


def similarity(a: str, b: str) -> float:
    """0.0 ~ 1.0. 정규화 후 SequenceMatcher ratio."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()


def threshold_for_length(normalized_name: str) -> float:
    """OCR 닉네임 정규화 길이별 임계값."""
    n = len(normalized_name)
    if n <= 4:
        return 1.0  # exact only
    if n <= 9:
        return 0.80
    return 0.85


@dataclass
class MatchCandidate:
    kingshot_id: str
    nickname: str
    score: float


@dataclass
class MatchResult:
    matched: MatchCandidate | None  # 임계값 통과한 best 후보, 없으면 None
    candidates_top3: list[MatchCandidate]  # score desc top 3 (검수 시 사용)
    threshold: float  # 적용된 임계값 (디버그용)


def match(
    ocr_name: str,
    db_members: list[dict],
) -> MatchResult:
    """OCR 닉네임 vs DB members 매칭.

    db_members: [{kingshot_id: str, nickname: str, ...}, ...]
    매칭 성공 조건: best score >= 가변 임계값.
    """
    nocr = normalize(ocr_name)
    threshold = threshold_for_length(nocr)

    # 모든 멤버에 대해 score 계산
    scored: list[MatchCandidate] = []
    for m in db_members:
        nick = m.get("nickname", "") or ""
        s = similarity(ocr_name, nick)
        scored.append(
            MatchCandidate(
                kingshot_id=str(m.get("kingshot_id", "")),
                nickname=nick,
                score=s,
            )
        )

    # score desc 정렬
    scored.sort(key=lambda c: c.score, reverse=True)
    top3 = scored[:3]

    matched = top3[0] if top3 and top3[0].score >= threshold else None
    return MatchResult(matched=matched, candidates_top3=top3, threshold=threshold)
