# 준준 TRIP (foodtrip)

가족 휴양지·맛집 리스트를 PC/폰 겸용 지도 앱으로. 집(덕소)·숙소 기준 거리·경로, 여행 플래너, 네이버/카카오/구글 연동.
사이트: **https://butimsorry83.github.io/foodtrip/** (GitHub Pages, 저장소 `Butimsorry83/foodtrip`, 브랜치 `main` 루트)

## 1. 파일 올리기 (업데이트 방법)
1. **https://github.com/Butimsorry83/foodtrip/upload/main** ← 바로 업로드 화면
2. 바뀐 파일을 드래그 (같은 이름이면 자동 덮어쓰기)
   - 루트 파일(`index.html` `app.js` `style.css` `tokens.css` `README.md`) → 그대로 드래그
   - 하위 폴더 파일(`data/db.json`, `assets/…`, `photos/base/…`) → **폴더째** 드래그하거나, 저장소에서 그 폴더로 들어간 뒤 `Add file › Upload files`
   - 한 번에 최대 100개
3. 제목(커밋 메시지) 적고 **Commit changes** → 1~2분 뒤 사이트 **Ctrl+F5** (그래도 예전 화면이면 주소 끝에 `?v=2`)

**제목 짓는 법**: `무엇: 한 줄 요약` — 소문자 영문 접두어 + 콜론 + 한글 요약
| 상황 | 제목 예 |
|---|---|
| 앱 코드 수정 | `app: 플래너 숙소 기준 반영` |
| 디자인·CSS | `style: 다크모드 지도 반전` |
| 데이터 갱신 | `data: 좌표 수집 2026-11-01` |
| 사진 추가 | `photos: 남해 대표사진 3장` |
| 문서 | `docs: README 키 만료일` |

앱에서 저장(가고싶다·방문 기록 등)하면 `data/db.json`은 **자동 커밋**되므로 손으로 올리지 않는다. 손으로 db.json을 올릴 때는 앱을 먼저 닫아 충돌을 피한다 (충돌 시 앱이 3-way 병합하지만 수동 업로드가 덮어쓸 수 있음).

## 2. API 키 현황 (2026-11-01 기준)
| 키 | 어디서 | 저장 위치 | 만료·갱신 |
|---|---|---|---|
| GitHub 토큰 `jjtrip` | GitHub › Settings › Developer settings › Fine-grained tokens · 저장소 `foodtrip`만 · Contents **Read and write** | 기기별 브라우저 (앱 설정 › GitHub 토큰) | **2027-11-01 만료** → 재발급 후 각 기기 설정에 다시 붙여넣기. 없으면 읽기 전용 |
| 카카오 JavaScript 키 (앱 1609227) | developers.kakao.com › 앱 › **플랫폼 키** › JavaScript 키 | 공용 키는 `db.json meta.kakaoKey`, 개인 키는 기기별 | 만료 無. **도메인은 키 안의 "JavaScript SDK 도메인"에** `https://butimsorry83.github.io` 등록 (2026-07-21 키 체계 변경). 앱 관리 › 카카오맵 › 사용 설정 ON(첫 앱 무료 쿼터) |
| 카카오 REST 키 | 같은 앱 › 플랫폼 키 › REST API 키 | 기기별 | 길찾기(카카오모빌리티) 사용 설정. 브라우저 직접 호출은 CORS로 실패할 수 있음 → 실패 시 추정 소요시간 사용 |
| 구글 Places 키 | Google Cloud › Places API (New) | 기기별 | 웹사이트 제한 `https://butimsorry83.github.io/*`. 월 무료 한도 내 과금 0 |
| TourAPI 서비스키 (한국관광공사) | data.go.kr | **앱에 넣지 않음** — PC 명령줄 전용 | `py tools\tourapi_photos.py --key "…"` / `py tools\tourapi_coords.py --key "…"` |

원칙: 키·토큰은 저장소·db.json·채팅에 넣지 않는다 (공용 카카오 JS 키만 예외 — 도메인 제한이 있어 공개돼도 안전). 여권·예약 정보도 앱에 넣지 않는다.

## 3. 처음 설정 (새 기기)
1. 사이트 열기 → 폰은 "홈 화면에 추가"
2. 설정 › GitHub 토큰 › 붙여넣기 › 연결 확인 → "연결됨" (안 넣으면 보기·검색·길찾기만 가능)
3. (선택) 설정 › 카카오 REST · 구글 Places 키 입력
4. 설정 › 가족 프로필 · 거점 확인

## 4. 구성
| 파일 | 역할 |
|---|---|
| `index.html` `style.css` `tokens.css` `app.js` | 앱 본체 (정적, 서버 無). 디자인 토큰은 `tokens.css` |
| `data/db.json` | **유일한 데이터 파일** — 앱에서 편집하면 GitHub API로 커밋. 휴지통(`trash`, 30일) 포함 |
| `assets/` `photos/base/` | 로고·계절 배경·여행 표지 / 휴양지 대표사진(한국관광공사) |
| `vendor/` | Leaflet 1.9.4 + markercluster |
| `tools/bundle.py` | 오프라인 단일 HTML 빌드 → `dist/YYYY.MM.DD_준준TRIP.html` (`py tools\bundle.py`) |
| `tools/tourapi_*.py` | 관광공사 사진·좌표 수집 (PC) |
| `tools/test.mjs` | Playwright 기능 테스트 (`python3 -m http.server 8765` 후 `node tools/test.mjs`) |

바탕지도: OpenStreetMap 표준 타일 (CARTO가 2026-11부터 API 키를 요구해 교체). 다크모드는 타일 CSS 반전. 카카오맵은 바탕지도가 아니라 **장소 검색·좌표·주변 후보**에만 사용 (해외 지역 때문).

## 5. 동작 메모
- 거리·소요: 장소 나라에 맞는 거점 기준 (국내=집, 나트랑=Melia). 카카오 REST 키 있으면 실경로, 없으면 도로 추정. 좌표 없는 곳은 시·군 중심으로 "대략"
- 플래너: 목적지 시·군 + 숙소(동네/호텔) 지정 → 숙소 반경 안 휴양지 자동 선정 → 집 출발 · 숙소 숙박 · 마지막 날 귀가
- 저장: 기기마다 토큰 1회. 다른 기기가 먼저 저장했으면 3-way 병합(내가 바꾼 필드만 겹침). 삭제는 휴지통 30일
- 좌표 수집: 설정 › TourAPI 행 › "앱에서 좌표 일괄 수집" (국내 카카오, 해외 OSM 1초/건)
- 우리 장소: 장소 추가 › 유형 「우리 장소」(본가·처가·단골 등) → 보라 마름모 핀, 찾기 「우리」 칸, 상세 「거점으로 등록」
- 상세 작은 지도: 거점→장소. 카카오 REST 실경로 받으면 도로 실선(국내만), 아니면 점선 직선. 누르면 찾기 지도로
- 플래너 동선: 날짜별로 출발→도착(집·숙소) 이동이 가장 짧은 묶음·순서로 배정, 오전 절반 → 점심(다음 장소 방향) → 오후 → 저녁. 3곳이면 오래 머무는 1곳 단독 + 가까운 2곳 묶음. 숙소가 집에서 멀면 집보다 숙소에 가까운 곳만. 식당은 「식당 반경」(1·3·5·10km) 안, 귀가하는 날은 복귀 시각 안에 현지에서 먹고 출발할 수 있을 때만 저녁(집 앞 저녁 X) · 저녁은 양식 제외 · 유명 맛집만 반경×3 예외(미슐랭·블루리본 태그 / 우리 ★5 / 네이버 방문자·블로그 리뷰 1,000+ / 구글 4.5·리뷰 1,000+)
- 플래너: 휴양지 선택 안 하면 추천 상위 자동 구성 · 「근처 관광지 새로 찾기」(국내 카카오 관광명소, 해외 구글) → + 추가 시 휴양지로 등록 · 실제 숙소는 저장 시 거점 목록에 추가(체크)
- 우리 가족 기록: 홈 「우리 가족 기록 › 전체」/ 상세 「모아보기」/ 여행 「여행기」 → 월별 피드(사진 크게·넘김, 한줄평·메뉴·함께 간 사람), 종류·사람 필터, 기록 없는 방문지 목록에서 바로 「+ 기록」
- 안내서: 여행 › 「안내서 만들기」 → trip-guide-html v2 입력 JSON 다운로드(기간·숙소·일행·근처 15km 장소·사진 절대주소) + 클로드에 붙일 요청문 복사

## 6. 데이터 구조 (`data/db.json`)
```
meta   { updated, kakaoKey, naverListUrl, family:{names[], adults, kids[], seniors, spicyOK, notes} }
bases  [{ id, name, country, lat, lng, note, default_for, si, near[] }]
places [{ id, type: spot|restaurant, country, region, name, lat, lng, si, do, address, seasons[], cuisine, tags[],
          spot_id, naver:{rating, reviews, saved, url}, kakao:{url, phone}, google:{rating, reviews, url},
          hours, parking, wish, visits, visitLog:[{id, date, who[], memo, stars, photo}], basePhoto:{path, source} }]
trips  [{ id, title, city, country, year, items:[{ day, time, activity, place, place_id, note }], plan:{…} }]
trash  [{ id, kind, at, name, item }]
```
