import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { loadPaymentWidget } from '@tosspayments/payment-widget-sdk';

const AI_WS_URL = 'ws://localhost:8000/ws/audio';
const API_BASE_URL = 'http://localhost:8000';

const menuCatalog = [
  {
    id: 'coffee',
    name: '커피',
    items: [
      { id: 'americano', name: '아메리카노', price: 3000, tags: ['coffee', 'basic'], image: '☕' },
      { id: 'latte', name: '카페라떼', price: 4000, tags: ['coffee', 'milk'], image: '🥛' },
      { id: 'cappuccino', name: '카푸치노', price: 4500, tags: ['coffee', 'milk'], image: '☁' },
    ],
  },
  {
    id: 'dessert',
    name: '디저트',
    items: [
      { id: 'cookie', name: '쿠키', price: 2000, tags: ['dessert', 'sweet'], image: '🍪' },
      { id: 'cake', name: '케이크', price: 5000, tags: ['dessert', 'sweet'], image: '🍰' },
      { id: 'muffin', name: '머핀', price: 2500, tags: ['dessert', 'bread'], image: '🧁' },
    ],
  },
  {
    id: 'drink',
    name: '음료',
    items: [
      { id: 'juice', name: '오렌지 주스', price: 3500, tags: ['cold', 'fruit'], image: '🍊' },
      { id: 'smoothie', name: '딸기 스무디', price: 4000, tags: ['cold', 'fruit'], image: '🍓' },
    ],
  },
];

const allMenuItems = menuCatalog.flatMap((category) => category.items);

const initialKdsOrders = [
  { id: 'KDS-001', menu: '아메리카노 외 1건', qty: 2, status: '조리 대기', createdAt: '10:12' },
  { id: 'KDS-002', menu: '카페라떼', qty: 1, status: '조리 중', createdAt: '10:18' },
  { id: 'KDS-003', menu: '쿠키 세트', qty: 3, status: '완료 대기', createdAt: '10:24' },
];

const initialAuditLogs = [
  { id: 1, time: '2026-05-17 10:08', event: '관리자 로그인', user: 'admin', detail: 'IP 192.168.0.21' },
  { id: 2, time: '2026-05-17 10:12', event: 'KDS 주문 수신', user: 'system', detail: 'KDS-001 접수' },
  { id: 3, time: '2026-05-17 10:16', event: 'AI 응답 지연', user: 'system', detail: '5초 초과, 터치 스냅샷 대기' },
];

const statusLabel = {
  connecting: '연결 중',
  open: '연결됨',
  closed: '연결 끊김',
  error: '오류',
};

const formatPrice = (value) => `${value.toLocaleString('ko-KR')}원`;

function App() {
  const [currentScreen, setCurrentScreen] = useState('menu');
  const [selectedCategory, setSelectedCategory] = useState(menuCatalog[0].id);
  const [cart, setCart] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [kdsOrders, setKdsOrders] = useState(initialKdsOrders);
  const [adminLogs, setAdminLogs] = useState(initialAuditLogs);
  const [wsStatus, setWsStatus] = useState('closed');
  const [retryCount, setRetryCount] = useState(0);
  const [message, setMessage] = useState('환영합니다. 음성 또는 화면 터치로 주문을 시작하세요.');
  const [error, setError] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [responseDelayTriggered, setResponseDelayTriggered] = useState(false);
  const [needSnapshotTouch, setNeedSnapshotTouch] = useState(false);
  const [ageEstimate, setAgeEstimate] = useState(null);
  const [highContrast, setHighContrast] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [snapshotStatus, setSnapshotStatus] = useState('대기 중');
  const [paymentStatus, setPaymentStatus] = useState('결제 위젯을 준비하지 않았습니다.');

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const workerRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const responseTimeoutRef = useRef(null);
  const lastAudioHashRef = useRef('');

  const totalPrice = useMemo(
    () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [cart],
  );

  const totalQuantity = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart],
  );

  const selectedItems = useMemo(
    () => menuCatalog.find((category) => category.id === selectedCategory)?.items || [],
    [selectedCategory],
  );

  useEffect(() => {
    workerRef.current = new Worker(new URL('./worker.js', import.meta.url));
    workerRef.current.onmessage = (event) => {
      if (event.data?.type === 'noise-reduced') {
        sendAudioToServer(event.data.buffer);
      }
    };

    connectWebSocket();

    return () => {
      stopVoiceStreaming(false);
      workerRef.current?.terminate();
      wsRef.current?.close();
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(responseTimeoutRef.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    setRecommendations(buildRecommendations(cart));
  }, [cart]);

  useEffect(() => {
    if (!ageEstimate) return;
    setCurrentScreen('ageResult');
    speak(`예상 연령은 ${ageEstimate}세입니다. 연령대에 맞춘 추천 메뉴를 확인해 주세요.`);
  }, [ageEstimate]);

  const addAuditLog = (event, detail, user = 'system') => {
    const now = new Date();
    const time = now.toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    setAdminLogs((prev) => [
      { id: Date.now(), time, event, user, detail },
      ...prev,
    ]);
  };

  const speak = (text) => {
    setMessage(text);
    if (!ttsEnabled || !('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    window.speechSynthesis.speak(utterance);
  };

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    const websocket = new WebSocket(AI_WS_URL);
    wsRef.current = websocket;

    websocket.onopen = () => {
      setWsStatus('open');
      setRetryCount(0);
      setError('');
      speak('AI 서버와 연결되었습니다. 음성 주문을 시작할 수 있습니다.');
      addAuditLog('WebSocket 연결', AI_WS_URL);
    };

    websocket.onmessage = (event) => {
      clearResponseDelay();
      handleAiMessage(event.data);
    };

    websocket.onerror = () => {
      setWsStatus('error');
      setError('AI 서버 연결 중 오류가 발생했습니다. 데모 기능은 계속 사용할 수 있습니다.');
      addAuditLog('WebSocket 오류', 'AI 서버 연결 실패');
    };

    websocket.onclose = () => {
      setWsStatus('closed');
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimerRef.current);
    setRetryCount((prev) => {
      const next = Math.min(prev + 1, 5);
      reconnectTimerRef.current = window.setTimeout(connectWebSocket, next * 2000);
      return next;
    });
  };

  const handleAiMessage = (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      setError('AI 서버 응답 형식이 올바르지 않습니다.');
      addAuditLog('AI 응답 파싱 실패', String(rawMessage).slice(0, 80));
      return;
    }

    if (data.type === 'order' && data.item) {
      addToCart(data.item);
      speak(`${data.item.name}을 장바구니에 담았습니다.`);
    }

    if (data.type === 'age_estimate') {
      setAgeEstimate(data.age);
    }

    if (data.type === 'recommendation') {
      setRecommendations(data.items || []);
      setCurrentScreen('recommendations');
    }

    if (data.type === 'kds_status' && data.order) {
      setKdsOrders((prev) => [data.order, ...prev]);
      addAuditLog('KDS 주문 수신', `${data.order.id} 수신`);
    }
  };

  const startResponseDelayTimer = () => {
    clearTimeout(responseTimeoutRef.current);
    setResponseDelayTriggered(false);
    responseTimeoutRef.current = window.setTimeout(() => {
      setResponseDelayTriggered(true);
      setNeedSnapshotTouch(true);
      speak('AI 서버 응답이 지연되고 있습니다. 화면을 터치하면 오류 확인용 스냅샷을 전송합니다.');
      addAuditLog('AI 응답 지연', '5초 초과, 터치 스냅샷 요청');
    }, 5000);
  };

  const clearResponseDelay = () => {
    clearTimeout(responseTimeoutRef.current);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };

  const startVoiceStreaming = async () => {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = audioStream;
      const mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = async (event) => {
        if (!event.data.size) return;
        const buffer = await event.data.arrayBuffer();
        workerRef.current?.postMessage({ type: 'reduce-noise', buffer }, [buffer]);
      };

      mediaRecorder.start(400);
      setIsRecording(true);
      setError('');
      speak('음성 인식을 시작했습니다. 원하는 메뉴를 말씀해 주세요.');
    } catch {
      setError('마이크 권한이 필요합니다. 브라우저 권한을 허용한 뒤 다시 시도하세요.');
      speak('마이크 권한이 필요합니다.');
    }
  };

  const stopVoiceStreaming = (announce = true) => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsRecording(false);
    if (announce) speak('음성 인식을 종료했습니다.');
  };

  const sendAudioToServer = async (buffer) => {
    if (!buffer) return;

    const audioHash = `${buffer.byteLength}-${new Uint8Array(buffer)[0] || 0}`;
    if (lastAudioHashRef.current === audioHash) return;
    lastAudioHashRef.current = audioHash;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer);
      startResponseDelayTimer();
      return;
    }

    setError('AI 서버가 연결되지 않아 음성 데이터는 전송하지 못했습니다.');
  };

  const addToCart = (item) => {
    setCart((prev) => {
      const existing = prev.find((cartItem) => cartItem.id === item.id);
      if (existing) {
        return prev.map((cartItem) =>
          cartItem.id === item.id
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem,
        );
      }
      return [...prev, { ...item, quantity: 1 }];
    });
    speak(`${item.name}을 장바구니에 담았습니다.`);
  };

  const removeFromCart = (id) => {
    setCart((prev) => prev.filter((item) => item.id !== id));
  };

  const updateQuantity = (id, quantity) => {
    if (quantity <= 0) {
      removeFromCart(id);
      return;
    }
    setCart((prev) =>
      prev.map((item) => (item.id === id ? { ...item, quantity } : item)),
    );
  };

  const buildRecommendations = (cartItems) => {
    if (!cartItems.length) {
      return allMenuItems.filter((item) => ['latte', 'cookie', 'juice'].includes(item.id));
    }

    const cartIds = new Set(cartItems.map((item) => item.id));
    const rules = [
      { when: ['americano'], then: 'cookie', confidence: 0.82 },
      { when: ['latte'], then: 'cake', confidence: 0.76 },
      { when: ['cookie'], then: 'latte', confidence: 0.71 },
      { when: ['juice'], then: 'muffin', confidence: 0.68 },
      { when: ['smoothie'], then: 'cake', confidence: 0.74 },
    ];

    return rules
      .filter((rule) => rule.when.some((id) => cartIds.has(id)) && !cartIds.has(rule.then))
      .map((rule) => ({
        ...allMenuItems.find((item) => item.id === rule.then),
        confidence: rule.confidence,
      }))
      .filter(Boolean);
  };

  const captureSnapshot = async () => {
    try {
      setLoading(true);
      setSnapshotStatus('카메라 준비 중');
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });

      if (!videoRef.current) return;
      videoRef.current.srcObject = videoStream;
      await videoRef.current.play();
      await new Promise((resolve) => setTimeout(resolve, 600));

      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth || 640;
      canvas.height = videoRef.current.videoHeight || 480;
      canvas.getContext('2d').drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      const formData = new FormData();
      formData.append('snapshot', blob, `snapshot-${Date.now()}.jpg`);

      setSnapshotStatus('서버 전송 중');
      const response = await fetch(`${API_BASE_URL}/snapshot`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('snapshot failed');

      setSnapshotStatus('전송 완료');
      speak('오류 확인용 스냅샷을 전송했습니다.');
      addAuditLog('스냅샷 전송', 'AI 서버 지연 상황 캡처 완료');
      clearResponseDelay();
      videoStream.getTracks().forEach((track) => track.stop());
    } catch {
      setSnapshotStatus('전송 실패');
      setError('카메라 권한 또는 AI 서버 연결을 확인해 주세요.');
      speak('스냅샷 전송에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleTouchSnapshot = () => {
    if (needSnapshotTouch) captureSnapshot();
  };

  const submitOrderToKds = async () => {
    if (!cart.length) return;

    const order = {
      id: `KDS-${String(Date.now()).slice(-4)}`,
      menu: cart.map((item) => `${item.name} ${item.quantity}개`).join(', '),
      qty: totalQuantity,
      status: '조리 대기',
      createdAt: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
    };

    try {
      setLoading(true);
      await fetch(`${API_BASE_URL}/kds/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
    } catch {
      setError('KDS API 서버가 없어 로컬 데모 주문으로 접수했습니다.');
    } finally {
      setKdsOrders((prev) => [order, ...prev]);
      addAuditLog('KDS 주문 접수', `${order.id} / ${order.menu}`);
      setCart([]);
      setCurrentScreen('kds');
      setLoading(false);
      speak('주문이 KDS에 접수되었습니다.');
    }
  };

  const updateKdsStatus = (id, status) => {
    setKdsOrders((prev) =>
      prev.map((order) => (order.id === id ? { ...order, status } : order)),
    );
    addAuditLog('KDS 상태 변경', `${id} -> ${status}`, 'admin');
  };

  const simulateAgeEstimate = () => {
    const age = [18, 24, 32, 46, 61][Math.floor(Math.random() * 5)];
    setAgeEstimate(age);
  };

  const simulateSlowAi = () => {
    setError('');
    speak('AI 서버 응답 지연 상황을 시뮬레이션합니다.');
    startResponseDelayTimer();
  };

  const handlePayment = async () => {
    if (!cart.length) {
      setPaymentStatus('결제할 메뉴가 없습니다.');
      return;
    }

    try {
      setLoading(true);
      setPaymentStatus('토스페이먼츠 결제 위젯을 불러오는 중입니다.');
      const paymentWidget = await loadPaymentWidget(
        'test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq',
        'payment-widget',
      );
      paymentWidget.renderPaymentMethods('#payment-widget', totalPrice);
      setPaymentStatus('결제 수단을 선택한 뒤 결제 요청을 진행할 수 있습니다.');
    } catch {
      setPaymentStatus('결제 위젯을 불러오지 못했습니다. 테스트 키와 네트워크 상태를 확인하세요.');
    } finally {
      setLoading(false);
    }
  };

  const completeDemoPayment = () => {
    if (!cart.length) return;
    setPaymentStatus('데모 결제가 완료되었습니다.');
    submitOrderToKds();
  };

  const renderTopBar = () => (
    <header className="top-bar">
      <div>
        <p className="eyebrow">VOICE KIOSK</p>
        <h1>음성 인식 키오스크</h1>
      </div>
      <nav className="nav-buttons" aria-label="화면 이동">
        {[
          ['menu', '메뉴'],
          ['cart', `장바구니 ${totalQuantity}`],
          ['recommendations', '추천'],
          ['kds', 'KDS'],
          ['admin', '관리자'],
        ].map(([screen, label]) => (
          <button
            key={screen}
            className={currentScreen === screen ? 'active' : ''}
            onClick={() => setCurrentScreen(screen)}
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  );

  const renderSystemPanel = () => (
    <section className="system-panel">
      <div>
        <span className={`status-dot ${wsStatus}`} />
        AI 서버: {statusLabel[wsStatus]} {retryCount > 0 && `(재연결 ${retryCount}/5)`}
      </div>
      <div>TTS 안내: {ttsEnabled ? '켜짐' : '꺼짐'}</div>
      <div>스냅샷: {snapshotStatus}</div>
      {responseDelayTriggered && <strong>응답 지연 감지됨</strong>}
    </section>
  );

  const renderMenu = () => (
    <main className="screen menu-layout">
      <section className="assist-panel">
        <h2>주문 도우미</h2>
        <p>{message}</p>
        {error && <p className="error">{error}</p>}
        {needSnapshotTouch && <p className="hint">화면을 한 번 터치하면 오류 확인용 스냅샷을 전송합니다.</p>}
        <div className="action-row">
          <button className="primary" onClick={isRecording ? stopVoiceStreaming : startVoiceStreaming}>
            {isRecording ? '음성 중지' : '음성 시작'}
          </button>
          <button onClick={captureSnapshot}>스냅샷 캡처</button>
          <button onClick={simulateSlowAi}>5초 지연 테스트</button>
          <button onClick={simulateAgeEstimate}>연령 추정 데모</button>
        </div>
      </section>

      <section>
        <div className="category-tabs">
          {menuCatalog.map((category) => (
            <button
              key={category.id}
              className={selectedCategory === category.id ? 'active' : ''}
              onClick={() => setSelectedCategory(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>
        <div className="item-grid">
          {selectedItems.map((item) => (
            <article key={item.id} className="item-card">
              <div className="item-image">{item.image}</div>
              <h3>{item.name}</h3>
              <p>{formatPrice(item.price)}</p>
              <button className="primary" onClick={() => addToCart(item)}>담기</button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );

  const renderCart = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>장바구니</h2>
        <strong>{formatPrice(totalPrice)}</strong>
      </div>
      {!cart.length ? (
        <p className="empty">장바구니가 비어 있습니다. 메뉴 화면에서 상품을 담아 주세요.</p>
      ) : (
        <div className="cart-list">
          {cart.map((item) => (
            <article key={item.id} className="cart-item">
              <div>
                <h3>{item.name}</h3>
                <p>{formatPrice(item.price)} / 합계 {formatPrice(item.price * item.quantity)}</p>
              </div>
              <div className="quantity-controls">
                <button onClick={() => updateQuantity(item.id, item.quantity - 1)}>-</button>
                <span>{item.quantity}</span>
                <button onClick={() => updateQuantity(item.id, item.quantity + 1)}>+</button>
                <button onClick={() => removeFromCart(item.id)}>삭제</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="action-row">
        <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
        <button onClick={() => setCurrentScreen('recommendations')}>추천 확인</button>
        <button className="primary" disabled={!cart.length} onClick={() => setCurrentScreen('payment')}>
          결제하기
        </button>
      </div>
    </main>
  );

  const renderRecommendations = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>FP-Growth 추천 메뉴</h2>
        <p>장바구니 조합을 기준으로 함께 구매할 가능성이 높은 메뉴를 보여줍니다.</p>
      </div>
      <div className="recommendation-list">
        {recommendations.map((item) => (
          <article key={item.id} className="recommendation-card">
            <div className="item-image">{item.image}</div>
            <h3>{item.name}</h3>
            <p>{formatPrice(item.price)}</p>
            <small>신뢰도 {Math.round((item.confidence || 0.64) * 100)}%</small>
            <button className="primary" onClick={() => addToCart(item)}>장바구니 담기</button>
          </article>
        ))}
      </div>
    </main>
  );

  const renderPayment = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>결제</h2>
        <strong>{formatPrice(totalPrice)}</strong>
      </div>
      <p>{paymentStatus}</p>
      <div id="payment-widget" className="payment-widget" />
      <div className="action-row">
        <button onClick={() => setCurrentScreen('cart')}>장바구니로 돌아가기</button>
        <button onClick={handlePayment}>결제 위젯 불러오기</button>
        <button className="primary" disabled={!cart.length} onClick={completeDemoPayment}>데모 결제 완료</button>
      </div>
    </main>
  );

  const renderAgeResult = () => (
    <main className="screen age-result">
      <h2>연령 추정 결과</h2>
      <p className="age-number">{ageEstimate}세</p>
      <p>추정 결과에 따라 고대비 UI와 추천 화면으로 빠르게 이동할 수 있습니다.</p>
      <div className="action-row">
        <button onClick={() => setHighContrast(true)}>고대비 UI 켜기</button>
        <button onClick={() => setCurrentScreen('recommendations')}>추천 메뉴 보기</button>
        <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
      </div>
    </main>
  );

  const renderKds = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>KDS 주문 현황</h2>
        <button className="primary" disabled={!cart.length} onClick={submitOrderToKds}>
          현재 장바구니 접수
        </button>
      </div>
      <div className="kds-list">
        {kdsOrders.map((order) => (
          <article key={order.id} className="kds-card">
            <div>
              <h3>{order.id}</h3>
              <p>{order.menu}</p>
              <small>{order.createdAt} / 수량 {order.qty}</small>
            </div>
            <select value={order.status} onChange={(event) => updateKdsStatus(order.id, event.target.value)}>
              <option>조리 대기</option>
              <option>조리 중</option>
              <option>완료 대기</option>
              <option>전달 완료</option>
            </select>
          </article>
        ))}
      </div>
    </main>
  );

  const renderAdmin = () => (
    <main className="screen admin-layout">
      <section>
        <h2>관리자 설정</h2>
        <label className="toggle-row">
          <input type="checkbox" checked={highContrast} onChange={(event) => setHighContrast(event.target.checked)} />
          고대비 UI
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={ttsEnabled} onChange={(event) => setTtsEnabled(event.target.checked)} />
          TTS 안내 멘트
        </label>
        <div className="action-row">
          <button onClick={connectWebSocket}>WebSocket 재연결</button>
          <button onClick={() => addAuditLog('관리자 점검', '수동 점검 로그 추가', 'admin')}>감사 로그 추가</button>
        </div>
      </section>
      <section>
        <h2>보안 감사 로그</h2>
        <div className="audit-list">
          {adminLogs.map((log) => (
            <article key={log.id} className="audit-card">
              <strong>{log.event}</strong>
              <p>{log.time} / {log.user}</p>
              <small>{log.detail}</small>
            </article>
          ))}
        </div>
      </section>
    </main>
  );

  return (
    <div className={`App ${highContrast ? 'high-contrast' : ''}`} onPointerDown={handleTouchSnapshot}>
      {renderTopBar()}
      {renderSystemPanel()}
      {loading && <div className="loading">처리 중...</div>}
      {currentScreen === 'menu' && renderMenu()}
      {currentScreen === 'cart' && renderCart()}
      {currentScreen === 'recommendations' && renderRecommendations()}
      {currentScreen === 'payment' && renderPayment()}
      {currentScreen === 'ageResult' && renderAgeResult()}
      {currentScreen === 'kds' && renderKds()}
      {currentScreen === 'admin' && renderAdmin()}
      <video ref={videoRef} className="hidden-video" muted playsInline />
    </div>
  );
}

export default App;
