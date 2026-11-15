# DKU Voice 프론트엔드

React 18 · JavaScript · Vite 기반 음성인식 키오스크입니다. 기존 메뉴·장바구니·결제·KDS·관리자 화면에 최신 `/api` 규격을 연결합니다. 상태와 화면 전환은 `App.jsx`의 React hooks로 관리하며 별도 라우터는 사용하지 않습니다.

```sh
npm ci
npm run dev
```

현재 작업 환경에는 테스트 클라이언트 키가 `.env.local`에 설정되어 있습니다. 새 환경에서는 `.env.example`을 참고하여 직접 설정하세요. 시크릿 키와 계정 비밀번호는 프론트 환경변수에 넣지 않습니다.

- 배포 API: `VITE_API_BASE_URL=`이면 `/api/...` 상대경로
- 개발 프록시: `BACKEND_PROXY_TARGET=https://dku-voice.com` (로컬 백엔드 사용 시 `http://127.0.0.1:8080`)
- 음성 연결: `VITE_AI_WS_URL=`이면 현재 host의 `/ws/audio`, HTTPS에서는 WSS
- 사진 전송: `VITE_AI_SNAPSHOT_URL`은 기존 multipart 계약이 확인된 경우에만 설정

```sh
npm test
npm run lint
npm run build
npm run preview
```

서버 메뉴를 불러오지 못하면 예시 메뉴를 표시하며 주문 버튼을 잠급니다. 결제는 최신 명세의 `TEST` 승인 경로를 사용합니다. 외부 토스 결제 요청 버튼은 실행하지 않으며, 기존 결제 수단 표시 영역은 유지합니다. 정상 결제 화면에 별도의 테스트·과금 안내 배너는 추가하지 않았습니다.

실제 서버 검증 상태와 파일별 변경 내용은 [연동 보고서](docs/INTEGRATION_REPORT.md), 조회 응답 기록은 [API 확인 결과](docs/API_VERIFICATION.json)를 참고하세요. 보고서에서 확인하지 않은 API를 실제 연동 완료로 간주하지 마세요.
