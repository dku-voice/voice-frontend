# HTTP 500 요청·서버 원인 구분 보고서

검증: 2026-11-15 15:51~15:54 한국시간. 배포 출처: `https://dku-voice.com`. 작업 브랜치 `feature/kiosk-ui`.

## 결론

최신 명세와 비교해 현재 프론트엔드 요청의 명백한 URL·메서드·헤더·파라미터 오류를 발견하지 못했습니다. 프론트 공통 클라이언트, 브라우저, 로컬 Vite 프록시를 모두 거치지 않은 최소 GET 요청에서도 HTTP 500이 재현됩니다. 따라서 프론트 요청 수정으로 해결할 근거가 없으며, 배포 서버/API 처리 경로의 로그 확인이 필요합니다.

DB·Redis·JWT·배포 버전·Nginx 중 어느 것이 실제 원인인지는 현재 응답만으로 확정할 수 없습니다. 실제 서버의 예외 스택과 내부 서비스 응답을 확인하지 못했습니다.

소스와 화면은 수정하지 않았고 이 보고서와 비밀값 없는 검증 JSON만 추가했습니다. 외부 요청은 GET뿐이며 주문·결제·환불·상태 변경·로그인·로그아웃은 실행하지 않았습니다. 커밋·푸시·배포도 하지 않았습니다.

## 1. 실제 URL과 최신 명세

배포 기본 주소는 `VITE_API_BASE_URL=`로 빈 값입니다. 개발에서는 `http://127.0.0.1:5173/api/...`를 Vite가 `https://dku-voice.com/api/...`로 전달합니다.

| 용도 | 최신 명세/현재 코드 | 배포 직접 GET | 로컬 프록시 GET |
| --- | --- | --- | --- |
| 전체 메뉴 | `/api/menus` | 500 | 500 |
| KDS 목록 | `/api/kds/orders?storeId=store-default` | 500 | 500 |
| 관리자 주문 목록 | `/api/admin/orders?storeId=store-default` | 500 | 500 |

KDS와 관리자 **실제 서버 진단 요청은 토큰 없이** 보냈습니다. 이는 공개 메뉴와 함께 서버의 실패 응답을 확인하기 위한 요청이며, 로그인된 정상 조회를 검증했다는 뜻은 아닙니다. 최신 명세에서는 이 경우 403이 예상되지만 실제로는 500입니다.

관리자 결제 목록·상세·통계의 URL도 코드와 최신 명세를 대조했습니다. `/api/admin/payments`, `/api/admin/orders/{숫자ID}`, `/api/admin/stats/sales`, `/api/admin/stats/menus`이며 이전 `/admin/...`, `/kds/...` 경로로 우회하지 않습니다.

근거: `src/api/kiosk.js:48`, `:89`, `:100` 및 `src/App.jsx:730`, `:821`, `:867`.

## 2. HTTP 메서드

메뉴·KDS·관리자 목록·상세·통계는 모두 GET입니다. 공통 클라이언트의 기본 메서드는 GET이며 읽기 API에서 POST/PATCH로 바뀌지 않습니다. 실제 Vite 프록시를 통과한 로컬 검증에서도 전부 GET으로 도착했습니다.

근거: `src/api/client.js:29`, `src/api/kiosk.js`의 조회 함수, 검증 JSON의 `localMockProxy.requests`.

## 3. 헤더와 인증

- 공개 메뉴: `Accept: application/json`, Authorization 없음. 명세에 맞습니다.
- 보호 요청: App에서 현재 세션의 `accessToken`을 `token` 옵션으로 넘기고, 공통 클라이언트가 `Authorization: Bearer {토큰}`을 설정합니다. 토큰을 쿼리나 GET 본문에 넣지 않습니다.
- 로컬 모의 서버에서 실제 API 클라이언트와 실제 프로젝트 Vite 설정을 함께 실행해 헤더가 유실되거나 Bearer가 중복되지 않음을 확인했습니다. 테스트용 임시 토큰은 로컬 모의 서버에만 사용했으며 보고서에는 값 대신 일치 여부만 저장했습니다.
- 토큰이 빈 보호 요청은 프론트에서 네트워크 전송 전에 중단됩니다.
- GET에는 본문이 없으므로 `Content-Type: application/json`을 붙이지 않는 것이 문제는 아닙니다. 요청에서 원하는 응답 형식은 Accept로 지정합니다.
- 실제 로그인 토큰의 유효기간·서명·서버 폐기 여부·권한은 검증하지 못했습니다. 새 로그인 요청은 읽기 전용 범위를 벗어나 실행하지 않았습니다.

근거: `src/App.jsx:813`, `:860`, `src/api/client.js:35`, `:86`, `src/api/kiosk.js:43`.

## 4. 파라미터와 데이터 구조

- 메뉴 전체 조회: 파라미터 없음. 선택적 categoryId는 숫자만 허용합니다.
- KDS·관리자 목록: `storeId=store-default`.
- 통계: `storeId`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`. 존재하지 않는 상세 필터를 추측해 추가하지 않았습니다.
- GET 본문은 없습니다. 로컬 모의 서버가 받은 본문 길이는 모든 요청에서 0바이트였습니다.
- API 응답은 서버 HTTP 상태를 먼저 확인하고 `{success,data,message}`를 검증한 뒤 data를 추출합니다.

근거: `src/api/kiosk.js:13`, `:20`, `src/api/client.js:112`.

## 5. HTTP 상태와 응답 본문

배포 서버에서 실제 받은 예시는 다음과 같습니다.

```http
GET https://dku-voice.com/api/menus
Accept: application/json

HTTP 500
Content-Type: application/json
Server: nginx/1.31.0
```

```json
{
  "status": 500,
  "message": "서버 오류가 발생했습니다.",
  "timestamp": "2026-11-15T06:51:56.626340299"
}
```

이는 프론트가 만들어 낸 오류 코드가 아니라 실제 HTTP 응답 상태입니다. DB 오류명·예외 클래스·실패 SQL 등은 본문에 없어 원인을 특정할 수 없습니다. Nginx Server 헤더만으로 Spring 내부인지 Nginx의 오류 가공인지도 확정할 수 없습니다.

실제 실패 응답은 최신 명세의 `success/data/message` 형태 대신 `status/message/timestamp`입니다. 그러나 공통 클라이언트는 HTTP 실패를 먼저 검사하므로 이 envelope 차이가 서버의 HTTP 500을 만들어내는 원인은 아닙니다. 배포 버전과 서버 공통 예외 처리 규격을 확인할 근거입니다.

브라우저/프론트 코드 없이 `GET https://dku-voice.com/api/menus`만 보내도 500이었습니다. Accept만 지정한 요청, 지정하지 않은 최소 요청, Origin을 포함한 요청에서 모두 같은 실패 메시지를 확인했습니다. 따라서 500 자체는 프론트 JSON 파싱이나 로컬 프록시에서만 발생하는 문제가 아닙니다. 별도의 브라우저 CORS 동작을 모두 검증했다는 의미는 아닙니다.

## 6. 공통 클라이언트와 프록시

프로젝트 Vite 설정의 `/api` 프록시는 `changeOrigin: true`, 대상 `https://dku-voice.com`이며 `/api`를 제거하는 rewrite가 없습니다. 실제 설정의 전달 대상만 로컬 모의 서버로 바꾼 임시 검증 서버를 실행해 다음을 확인했습니다. 프로젝트 설정 파일 자체는 바꾸지 않았습니다.

- 메뉴·카테고리 메뉴·KDS·관리자 주문·결제 목록·매출 통계·인기 메뉴 7개 GET 경로 보존
- Accept와 Bearer 전달, 토큰 값 일치, 본문 0바이트
- Host가 upstream으로 변경되어 changeOrigin 작동
- 빈 토큰 요청이 upstream에 도착하지 않음
- 실제 배포 요청과 로컬 프록시 요청에서 동일한 HTTP 500 재현

공통 API·명세 함수 회귀 테스트도 다시 실행해 **19개 전부 통과**했습니다. 이 테스트는 모의 응답이며 실제 인증 성공 검증은 아닙니다.

근거: `vite.config.js:6`, `:11`, `src/api/client.js:20`, `:86` 및 검증 JSON.

## 추가로 확인된 배포 문서 경로

실제 리디렉션은 다음과 같습니다.

```text
/swagger-ui/index.html → 301 /swagger-ui/index → 301 /swagger-ui → 200
```

최종 내용은 `Vite + React` HTML이며 Swagger UI 스크립트가 없습니다. `/v3/api-docs`도 OpenAPI JSON이 아니라 프론트 첫 화면과 동일한 HTML을 반환합니다. 따라서 Swagger 문서가 정상 제공되는 상태는 확인하지 못했습니다. 이 현상은 문서 경로가 프론트 라우팅으로 처리된다는 근거이며, API 500의 직접 원인이라고 확정한 것은 아닙니다.

## 검증 사실과 추정의 구분

| 구분 | 내용 |
| --- | --- |
| 검증된 사실 | 최신 요청 경로·메서드·파라미터와 코드가 일치하며 모의 upstream에서 헤더/경로가 보존됨 |
| 검증된 사실 | 인증 불필요 메뉴의 최소 직접 GET이 실제 HTTP 500을 반환함 |
| 검증된 사실 | 토큰 없는 KDS·관리자 진단 GET도 HTTP 500이며 명세상 예상 403과 다름 |
| 검증된 사실 | 로컬 백엔드 사본에는 `/api/**` 전체 허용과 이전 `/admin/**`·`/kds/**` 보안 경로가 있음. 최신 명세와 다르지만 실제 배포 코드인지 확인 못 함 |
| 검증된 사실 | 로컬 메뉴 구현은 Redis 캐시 및 DB 조회를 사용하고 범용 예외 처리기가 상세 원인을 숨긴 일반 500 메시지를 반환함 |
| 미검증/추정 | 실제 배포 버전의 컨트롤러 또는 보안 경로가 최신 명세와 다른지 |
| 미검증/추정 | DB 연결·스키마·SQL·DTO 직렬화 또는 Redis 접속·캐시 역직렬화 실패인지 |
| 미검증/추정 | 인증·접근 거부·없는 경로 예외가 일반 예외 처리기에 잡혀 500으로 변환되는지 |
| 미검증/추정 | Nginx upstream·location·rewrite·문서 경로 fallback 설정 문제인지 |

현재 로컬 메뉴 엔티티는 컬렉션이 Set+List이며 DTO 변환은 트랜잭션 안에서 이뤄집니다. 흔한 MultipleBagFetchException이나 LazyInitializationException을 현재 원인이라고 단정할 근거는 없습니다.

## 백엔드/배포 담당자의 확인 순서

1. **로그와 시간 대조**: 2026-11-15 한국시간 15:51:56~57(HTTP Date UTC 06:51:56~57)의 메뉴·KDS·관리자 요청에 대해 Nginx access/error 로그의 upstream_status/upstream_addr와 Spring 예외 스택의 최초 Caused by를 확인하세요. 비밀번호·토큰은 공유하지 마세요.
2. **Nginx와 애플리케이션 분리**: 서버 내부에서 실제 Spring 서비스 포트의 `/api/menus`를 GET하여 외부 도메인 응답과 비교하세요. 내부도 500이면 애플리케이션 로그를, 내부 200/외부 500이면 Nginx upstream·경로 전달·Host 설정을 우선 확인할 수 있습니다.
3. **실행 버전과 매핑**: 현재 컨테이너 이미지/커밋과 실제 실행 중인 `/api/menus`, `/api/kds/orders`, `/api/admin/orders` 매핑이 최신 명세와 일치하는지 확인하세요. 로컬 백엔드 사본과 배포 서버가 같은 코드라는 보장은 없습니다.
4. **공개 API와 인증 오류 처리**: `/api/menus`는 토큰 없이 조회되어야 합니다. KDS/관리자는 명세상 역할 제한이 필요하고, 토큰 누락·만료·권한 부족은 403이어야 합니다. SecurityFilterChain 매처 순서, JWT 필터, AuthenticationEntryPoint/AccessDeniedHandler, 범용 ControllerAdvice가 이를 500으로 바꾸는지 확인하세요. 없는 컨트롤러 경로가 404 대신 일반 500이 되는지도 확인 대상입니다.
5. **메뉴 DB 경로**: 실제 DB 연결·연결 풀, 테이블/컬럼·마이그레이션, 메뉴/카테고리/알레르기/옵션/영양 조회 SQL과 DTO 변환·JSON 직렬화 오류를 로그로 확인하세요. 설정 값 자체는 외부에 노출하지 마세요.
6. **Redis 캐시 경로**: Redis 접근·인증·DB 인덱스·캐시 직렬화 형식과 배포 버전 간 캐시 호환성을 확인하세요. 로컬 코드의 MenuCacheService는 캐시 예외 시 DB로 우회하는 처리가 없어, 캐시에서 실패하면 DB 조회 전에도 실패할 가능성이 있습니다. 실제 원인 여부는 로그가 필요하며 이번 조사에서 캐시를 지우거나 설정을 바꾸지 않았습니다.
7. **문서 경로와 응답 규격**: Swagger/OpenAPI가 프론트 index.html로 넘어가는 경로와 서버 공통 오류 envelope가 최신 명세와 다른 이유를 확인하세요.

## 범위와 한계

유효한 실제 JWT로 인증 조회한 것은 아닙니다. 로그인·로그아웃·주문 생성·결제 승인·관리자 변경·캐시 삭제를 실행하지 않았습니다. 이번 조사에 서버 로그·EC2 내부 접근 권한은 없으므로 구체적인 서버 예외를 확정할 수 없습니다. 프론트 요청의 명백한 문제는 없어 기존 디자인·기능·코드는 임의로 변경하지 않았습니다.

상세 증거: [검증 JSON](HTTP_500_DIAGNOSIS_2026-11-15.json).

관련 로컬 코드:

- [API 클라이언트](../src/api/client.js)
- [API 경로 정의](../src/api/kiosk.js)
- [Vite 프록시](../vite.config.js)
- 백엔드 사본 `config/GlobalExceptionHandler.java:61`, `config/SecurityConfig.java:37`, `service/MenuCacheService.java:27`, `service/MenuService.java:25` (실제 배포 코드와 동일 여부 미확인)
