# 식도락 여행 (foodtrip)

가족 휴양지·맛집 LIST를 PC/폰 겸용 지도 앱으로. 거점(집·호텔) 기준 거리·경로, 여행 일정, 네이버/카카오/구글 연동.

## 구성
| 파일 | 역할 |
|---|---|
| `index.html` `style.css` `app.js` | 앱 본체 (정적, 서버 無) |
| `data/db.json` | **유일한 데이터 파일** — 앱에서 편집하면 GitHub API로 이 파일에 커밋됨 |
| `vendor/leaflet.*` | 지도 라이브러리 (Leaflet 1.9.4) |
| `tools/normalize.py` `tools/build_db.py` | 최초 엑셀 → JSON 변환 (이후 사용 불필요) |
| `tools/test.mjs` | Playwright 기능 테스트 |

## 최초 설정 (1회)
1. 저장소 **Settings → Pages → Build and deployment: Deploy from a branch → `main` / `/ (root)`** → 저장. 1~2분 후 `https://<계정>.github.io/foodtrip/`
2. **쓰기 토큰**: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained** → Repository access: `foodtrip`만 → Permissions: **Contents: Read and write** → 생성. 앱 **설정 탭**에 붙여넣기 (기기별 1회, 브라우저에만 저장)
3. **카카오 JavaScript 키**: developers.kakao.com → 앱 → 앱 키 → JavaScript 키. 플랫폼 Web 도메인에 `https://<계정>.github.io` 등록, **카카오맵 활성화 ON**. 앱 설정 탭 → 키 저장 → 연결 테스트
4. (선택) **카카오 REST 키**: 같은 카카오 앱 → REST API 키, 카카오모빌리티 길찾기 사용 설정 → 설정 탭 "실경로" 카드. 기기별 저장
5. (선택) **구글 Places 키**: Google Cloud → Places API (New) 사용 → API 키(HTTP 리퍼러 `https://<계정>.github.io/*` 제한) → 설정 탭 "구글 Places" 카드. 기기별 저장
6. 설정 탭 → **좌표 일괄 수집** (국내 카카오, 해외 OSM). 결과는 각 장소 상세에서 확인·수정
5. 폰: 사이트 열고 "홈 화면에 추가" → 앱처럼 사용

## 데이터 구조 (`data/db.json`)
```
meta   { updated, kakaoKey, naverListUrl }
bases  [{ id, name, country, lat, lng, note, default_for }]
places [{ id, type: spot|restaurant, country, region, name, lat, lng, rating, seasons[], cuisine,
          spot_id, address, signature, pay[], naver:{reviews, blog, rating, saved, url, date}, kakao:{url, phone}, visits, ... }]
trips  [{ id, title, city, country, year, items:[{ day, time, activity, place, note }] }]
```
