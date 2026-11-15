# 프론트엔드 API 연동 분석 및 검증 보고서

검증일: 2026-11-13. 작업 브랜치: `feature/kiosk-ui`.

프론트엔드 구현과 모의 검증은 진행했지만, 현재 배포 백엔드가 HTTP 500을 반환하므로 실제 서버를 통한 주문·결제·로그인·주방 처리 성공은 확인하지 못했습니다. 외부 서비스에서 주문 생성, 결제, 환불, 로그인, 관리자 상태 변경을 실행하지 않았습니다. 커밋·푸시·병합·배포도 하지 않았습니다.

## 기존 구조와 분석

```text
voice-frontend/
├── src/
│   ├── App.jsx, App.css       기존 화면·장바구니·마이크·TTS·화면 전환
│   ├── main.jsx, index.css    React StrictMode 시작점과 기본 스타일
│   ├── worker.js             WASM/JS 잡음 억제, Float32 → Int16
│   ├── wasm/                 기존 잡음 억제 WASM/WAT
│   ├── api/                  공통 HTTP 처리와 명세별 API 함수 (추가)
│   ├── domain/               메뉴·옵션·장바구니·주문·TEST 결제 처리 (추가)
│   └── integration/          주소·세션·인증 SSE 처리 (추가)
├── public/pcm-capture-processor.js  기존 마이크 AudioWorklet
├── tests/                    네트워크 없는 계약·오류·중복 방지 테스트
├── docs/                     분석·실제 조회 결과
└── vite.config.js            개발 프록시
```

실제 프로젝트는 React 18 / JavaScript / Vite입니다. TypeScript, Redux, React Router는 없습니다. 화면은 `currentScreen` 상태로 전환합니다. 기존 `README`, `package-lock.json`, `App.test.js`에는 이전 Create React App 설정이 남아 있어 현재 구성으로 정리했습니다. 별도 기능 패키지는 추가하지 않았습니다.

| 화면/기능 | 기존 구현과 문제 | 이번 연결 |
| --- | --- | --- |
| 메뉴 | 19개 하드코딩 상품, 이미지 이모지 | `/api/menus`를 기존 카드·카테고리 모양에 연결 |
| 메뉴 상세·옵션 | 별도 상세 화면·선택 기능 없음 | 카드 안 펼침 영역에 알레르기·영양·옵션 추가 |
| 장바구니 | 메뉴 slug만으로 합산 | 숫자 menuId와 옵션 조합별 행, 서버 주문 요청 생성 |
| 주문·영수증 | 실제 주문 생성/조회 없음 | 주문 생성·조회, 결제 후 서버 영수증 표시 |
| 결제 | 토스 위젯/인증창, 승인 없는 로컬 완료 | 기존 영역·버튼 유지, `데모 결제 완료`에서 서버 TEST 승인 |
| 로그인 | 없음 | KDS/관리자에 필요한 최소 로그인 폼 추가 |
| KDS | 예시 주문·로컬 상태 변경, localhost8000에 명세 외 POST | 인증 GET·SSE·상태 PATCH, 예시 접수 성공 처리 제거 |
| 관리자 | 접근성 설정·로컬 예시 감사 로그 | 기존 설정 유지, 관리자용 조회·판매 상태·TEST 환불 추가 |
| AI 추천 | 하드코딩 규칙과 기존 WS 메시지 | 기존 규칙 유지, REST 명세 확인 대기 |
| 연령 분석 | 임의 예시 나이와 기존 WS 결과 | 기존 시연 버튼 유지·예시 결과 표시, REST 계약 확인 대기 |
| 음성 | AudioWorklet→Worker/WASM→Int16 binary WS | 데이터 형식 유지, 주소·중복 시작·종료 정리 개선 |
| 사진 | localhost8000/snapshot, multipart snapshot | 확인된 주소를 명시할 때만 같은 계약 사용; 새 연령 API로 임의 대체하지 않음 |

기존 메뉴·장바구니·결제 레이아웃과 원래 CSS 규칙·애니메이션을 유지했습니다. 필요한 옵션·인증·영수증·관리 입력만 추가했습니다. 이전 요청의 `5초 지연 테스트` 제거와 `연령 추정` 라벨, 제공된 공개 테스트 클라이언트 키 설정도 유지했습니다.

## 수정 파일과 역할

| 파일 | 변경 이유 |
| --- | --- |
| `src/App.jsx` | 기존 화면에서 API 함수를 호출하고 로딩·오류·옵션·영수증·인증 상태를 표시 |
| `src/App.css` | 원래 규칙 뒤에 이미지·옵션·로그인 폼·고대비 오류 스타일만 추가 |
| `src/api/client.js` | HTTP 상태와 success 동시 검사, data 추출, JSON 오류, 15초 제한, Abort, Bearer와 403 처리 |
| `src/api/kiosk.js` | 최신 `/api` 메뉴·주문·TEST 결제·취소·인증·KDS·관리자 경로와 DTO 적용 |
| `src/domain/kiosk.js` | 상태 필터, 소스 한 개 선택, 옵션 가격, 장바구니 조합, 서버 영수증 검증 |
| `src/domain/checkout.js` | 주문·결제 중복 방지, 서버 확정 금액, 승인 후 GET 확인, 불확실한 요청 복구 |
| `src/integration/runtime.js` | API/WS/사진 URL과 store-default, HTTPS 혼합 콘텐츠 차단 |
| `src/integration/session.js` | sessionStorage 세션과 24시간 만료, 비밀번호 저장 금지, 로그아웃 정리 |
| `src/integration/sse.js` | fetch로 Authorization 헤더 전송, connect/new-order 파싱, 재연결·중복 이벤트·종료 정리 |
| `vite.config.js` | 개발에서 `/api`, `/ws`, `/ai` 프록시; 실제 Nginx 설정은 수정하지 않음 |
| `.env.example`, `.env.demo`, 로컬 `.env.local` | 빈 API base, WS host 기본값, 공개 클라이언트 키 유지; 시크릿 미보관 |
| `.eslintrc.cjs`, `package.json` | 현재 코드에 맞는 ESLint 설정과 Node test 명령 |
| `package-lock.json` | 남아 있던 CRA/React19 잠금 정보를 실제 React18/Vite 의존성에 맞춰 재생성 |
| `src/App.test.js`, `tests/*.test.js` | 오래된 learn-react 테스트를 교체하고 API·도메인·SSE·세션·화면 구조 검증 |
| `README.md`, `docs/*` | 실제 실행 방법, 분석, 미완료 사항과 조회 증거 |

`worker.js`, WASM, `pcm-capture-processor.js`, 백엔드·AI·Docker·Kafka·Nginx·GitHub 배포 워크플로는 변경하지 않았습니다.

## 실제 동작과 중요한 차이

- 메뉴 ACTIVE는 주문 가능, SOLD_OUT은 흐리게 표시하고 담기 불가, INACTIVE는 고객 메뉴에서 제외합니다. 서버가 실패하면 예시 메뉴임을 표시하고 실제 주문에 사용하지 않습니다.
- ADD/REMOVE 옵션을 서버 optionId로 보내며, 양념감자의 어니언·치즈·칠리 소스는 정확히 한 개만 선택합니다. 임의 옵션 그룹 필드는 만들지 않았습니다.
- 주문 요청에는 menuId·quantity·optionIds만 보냅니다. 가격은 서버가 계산한 totalPrice를 사용합니다.
- `데모 결제 완료`와 기존 KDS의 `현재 장바구니 접수`는 주문 생성 → `pgProvider: TEST`, `method: CARD` 승인 → 주문 GET 확인을 거칩니다. 단순히 버튼을 눌렀다는 이유로 성공을 표시하지 않습니다.
- TEST는 백엔드의 시연 승인 경로입니다. 토스 테스트 카드 인증과는 별개이며 토스 시크릿 키 없이도 이 백엔드 경로를 구현할 수 있습니다. 실제 서버 지원 여부는 아직 확인하지 못했습니다.
- 기존 토스 결제 수단·약관 표시 영역과 버튼 이름은 남겼습니다. 위젯은 공개 테스트 클라이언트 키로 표시할 수 있지만, 최신 요청이 TEST 결제이므로 `SDK 결제 요청`은 비활성화했습니다. 토스 인증/실결제 및 `/success`·`/fail` 승인 연결은 이번 구현에서 실행하지 않습니다.
- 생성/승인 POST를 자동 재시도하지 않습니다. 응답 유실 시 서버 주문 상태를 확인하고, 결과가 불명확하면 장바구니와 저장 기록을 남긴 채 재생성·재승인을 막습니다. 조회로도 처리 여부가 확인되지 않으면 담당자가 서버 내역을 확인해야 합니다.
- 일반 사용자에게 로컬 예시 KDS 주문을 실제 서버 접수 결과로 표시하지 않습니다. 결제 후 영수증은 볼 수 있고, 전체 KDS 목록은 STAFF/ADMIN 로그인 후 확인합니다.
- 감사 로그는 이 브라우저에서 발생한 작업 기록입니다. 서버 감사 로그 API는 명세에 없어 만들지 않았습니다.

## 검증 결과와 API 상태

자동 검증: `npm test` 최종 58개 통과, `npm run lint`·`npm run build` 통과. 별도 임시 폴더에서 `npm ci --ignore-scripts`로 새 설치 후 57개 테스트·정적 검사·발표용 빌드도 통과했으며, 이후 주문 항목 위변조 회귀 테스트 1개를 추가해 작업 폴더에서 재검증했습니다. 테스트는 모의 Response/ReadableStream과 Vite SSR 렌더를 사용했으며 실제 카드·마이크·카메라·브라우저 전체 동작을 검증했다는 뜻은 아닙니다.

포함된 검증: envelope/HTTP 오류·시간 초과·취소·403, 숫자 ID와 DTO, 품절·비활성·옵션 가격, 소스 단일 선택, 중복 클릭과 새로고침 복구, 서버 총액·PAID 확인, TEST 외 provider 차단, 세션 만료/비밀번호 미저장, WS ws/wss, SSE UTF-8/CRLF·Bearer·재연결·중복/정리, 기존 메뉴·결제 화면 구조.

실제 서버 조회 시각은 `API_VERIFICATION.json`에 기록했습니다. 조회만 실행했습니다.

| API | 구현 상태 | 실제 서버 검증 |
| --- | --- | --- |
| GET /api/menus | 코드 구현·모의 검증 완료 | HTTP 500, `서버 오류가 발생했습니다.` |
| POST /api/orders, GET /api/orders/{id} | 코드 구현·모의 검증 완료 | 운영 주문 생성 금지로 전체 흐름 미실행 |
| POST /api/payments/confirm (TEST) | 코드 구현·모의 검증 완료 | 실제 승인 요청 미실행 |
| POST /api/payments/cancel | 코드 구현·모의 검증 완료, 관리자 UI에서는 TEST만 허용 | 취소 요청 미실행 |
| /api/auth/login, /api/auth/logout | 코드 구현·모의 검증 완료 | 실제 계정 로그인·토큰 발급/폐기 미실행 |
| GET /api/kds/orders | 코드 구현·모의 검증 완료 | 토큰 없는 조회에서 HTTP 500; 정상 403/인증 조회는 검증 못 함 |
| /api/kds/stream, 상태 PATCH | 코드 구현·모의 검증 완료 | 실제 인증 SSE·조리 상태 변경 미실행 |
| GET /api/admin/orders | 코드 구현·모의 검증 완료 | 토큰 없는 조회에서 HTTP 500 |
| 관리자 상세·결제 목록·매출·인기 메뉴·상태 PATCH | 코드 구현·모의 검증 완료 | 실제 인증 조회·상태 변경 미실행 |
| /ai/api/vision/analyze_age, /ai/api/recommendations/menu | 명세 부족으로 구현 대기 | 인프라 경로 최종 확정 및 요청·응답 필요 |
| /ws/audio | 기존 프로토콜과 주소·자원 정리 구현 | 실제 음성 모델 응답·메뉴 해석 검증 대기 |
| /api/ai/menus | 프론트에서 호출하지 않음 | AI 서버 전용 규칙 준수 |
| 서버 감사 로그·관리자 전체 숨김 메뉴 조회 | 현재 프로젝트/최신 명세에 해당 API 없음 | 임의 경로를 만들지 않음 |

현재 정상적인 업무 응답으로 **구현 및 실제 서버 검증 완료**라고 부를 수 있는 API는 없습니다. 실패 응답을 수신했다는 사실과 실제 기능 성공은 다릅니다.

`/swagger-ui/index.html`은 HTTP 200이지만 `<title>Vite + React</title>`이고 `/`와 HTML이 같습니다. Swagger 문서가 열린 것이 아니라 프론트 SPA fallback으로 확인했습니다. 상세 필터를 실제 Swagger로 검증할 수 없어 관리자 목록에는 확인된 storeId만, 통계에는 명시된 from/to만 사용했습니다.

## 담당자에게 확인할 내용과 남은 위험

1. 백엔드: 메뉴·인증 필요 조회가 모두 HTTP 500인 원인의 서버 로그와 실제 배포 버전, DB/Redis 연결 상태 확인.
2. 백엔드: `/api`로 통일한 최신 코드가 배포되었는지, 정상/실패 공통 envelope와 403이 실제로 제공되는지 확인.
3. 백엔드: 사용자 승인을 받은 별도 테스트 환경에서 주문 → TEST 승인 → PAID → KDS new-order까지 공동 검증.
4. 백엔드: Swagger 실제 접근 주소, 관리자 목록의 date/status 필터, 비활성 메뉴까지 조회하는 관리자 메뉴 API 제공 여부. 현재 고객 메뉴 GET에서 제외된 INACTIVE 상품은 새로고침 후 전체 관리 목록에서 복원할 근거가 없습니다.
5. AI: 연령·추천 API 최종 URL, multipart 필드 이름/요청 JSON, 응답 예시, 나이·추천 메뉴 ID/확률 필드.
6. AI: WS의 실제 샘플레이트, PCM endian/프레임 길이, 시작·종료 메시지 필요 여부, order/age_estimate/recommendation 응답 계약. 기존 16k mono 요청·4096 Float32 수집·Int16 binary 전송은 유지했으며 서버 확인을 대신하지 않습니다.
7. 사진 업로드: 기존 `/snapshot` 계약을 새 연령 API와 동일하다고 볼 수 없습니다. 확인 전 자동 업로드하지 않습니다.
8. 서버 주문 상태가 조회로도 확인되지 않는 네트워크 실패는 자동 해결할 수 없습니다. 세션 저장소의 `voice-kiosk-checkout-v2`가 중복을 막으며, 임의 삭제보다 먼저 서버 내역을 확인해야 합니다.
9. UI는 코드와 SSR 구조를 확인했지만 실제 브라우저에서 모든 화면의 시각·접근성·권한 팝업을 확인한 것은 아닙니다.

## VS Code 실행과 배포 전 점검

현재 설치된 환경에서는 다음을 실행합니다.

```sh
npm run dev
npm test
npm run lint
npm run build
```

새 체크아웃에서는 먼저 `npm ci`를 실행합니다. `.env.local`의 기존 공개 키를 보존하고 `.env.example`의 필요한 변수를 확인하세요. `.env.demo`로 빌드하려면 `npm run build -- --mode demo`를 사용합니다. 환경변수 변경 후 개발 서버를 다시 시작해야 합니다.

배포 전에는 백엔드 HTTP 500 해결, TEST 전용 시연 환경에서 실제 전체 흐름 승인 후 검증, Nginx `/api`·`/ws` 전달과 SSE buffering/timeout, WSS와 마이크 HTTPS 권한, 계정 권한·토큰 만료, 실제 브라우저 화면 점검이 필요합니다. 이번 작업에서 서버 설정을 변경하거나 배포하지 않았습니다.

이번 작업 전 백업: `/private/tmp/voice-api-preserve-ui-uwvsm3cr`.
