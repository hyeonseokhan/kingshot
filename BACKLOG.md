# BACKLOG

## 보류 중

### 1. 연맹원 등급(R1~R5) OCR/매칭 정확도 개선
- 현재 alliance scraper 에 template matching 으로 R 등급 인식이 들어가 있으나 false positive 가 다수.
- 원인: 5개 R 템플릿이 배경 색상 동일 + 숫자만 다름 → matchTemplate 의 score 만으로 분류 안 됨.
- centurygame APK (com.run.tower.defense) 의 .unity3d 번들이 자체 LZ4 변형 압축으로 보호되어 표준 도구(UnityPy 등) 추출 불가.
- 향후 방향:
  - (a) 템플릿의 "숫자 영역만" crop 해서 별도 매칭 → score 차이 명확화
  - (b) 매치된 배지 영역 crop + upscale → OCR 으로 "1"~"5" 인식
  - (c) AssetRipper 등 다른 추출 도구 시도 (LZ4 변형 우회)
- 관련 파일: `client_tools/alliance_scraper/src/rows.py` (match_role_badges, find_role_for_row)
