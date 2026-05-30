import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { loadPaymentWidget } from '@tosspayments/payment-widget-sdk';

const AI_WS_URL = 'ws://localhost:8000/ws/audio';
const API_BASE_URL = 'http://localhost:8000';

const menuCatalog = [
  {
    id: 'burger',
    name: '버거',
    items: [
      { id: 'classic-burger', name: '클래식 버거', price: 5900, tags: ['burger', 'beef'], image: '🍔' },
      { id: 'cheese-burger', name: '치즈 버거', price: 6900, tags: ['burger', 'cheese'], image: '🧀' },
      { id: 'bulgogi-burger', name: '불고기 버거', price: 6500, tags: ['burger', 'bulgogi'], image: '🍔' },
      { id: 'bacon-cheese-burger', name: '베이컨 치즈 버거', price: 7900, tags: ['burger', 'bacon', 'cheese'], image: '🥓' },
      { id: 'double-bulgogi-burger', name: '더블 불고기 버거', price: 8500, tags: ['burger', 'bulgogi', 'double'], image: '🍔' },
      { id: 'steak-burger', name: '스테이크 버거', price: 9900, tags: ['burger', 'steak'], image: '🥩' },
      { id: 'chicken-burger', name: '치킨 버거', price: 6500, tags: ['burger', 'chicken'], image: '🍗' },
    ],
  },
  {
    id: 'side',
    name: '사이드',
    items: [
      { id: 'fries', name: '감자튀김', price: 2500, tags: ['side', 'potato'], image: '🍟' },
      { id: 'nuggets', name: '치킨너겟', price: 3500, tags: ['side', 'chicken'], image: '🍗' },
      { id: 'onion-rings', name: '어니언링', price: 3200, tags: ['side', 'fried'], image: '🧅' },
      { id: 'cheese-sticks', name: '치즈스틱', price: 3300, tags: ['side', 'cheese'], image: '🧀' },
      { id: 'crispy-tender', name: '크리스피 텐더', price: 4200, tags: ['side', 'chicken'], image: '🍗' },
    ],
  },
  {
    id: 'drink',
    name: '음료',
    items: [
      { id: 'cola', name: '콜라', price: 2000, tags: ['drink', 'soda'], image: '🥤' },
      { id: 'zero-cola', name: '제로 콜라', price: 2000, tags: ['drink', 'soda'], image: '🥤' },
      { id: 'lemonade', name: '레모네이드', price: 3000, tags: ['drink', 'fresh'], image: '🍋' },
      { id: 'sprite', name: '스프라이트', price: 2000, tags: ['drink', 'soda'], image: '🥤' },
      { id: 'zero-sprite', name: '제로 스프라이트', price: 2000, tags: ['drink', 'soda'], image: '🥤' },
      { id: 'orange-fanta', name: '오렌지 환타', price: 2000, tags: ['drink', 'soda'], image: '🍊' },
      { id: 'grape-fanta', name: '포도 환타', price: 2000, tags: ['drink', 'soda'], image: '🍇' },
    ],
  },
];

const allMenuItems = menuCatalog.flatMap((category) => category.items);

const initialKdsOrders = [
  { id: 'KDS-001', menu: '더블 불고기 버거 세트', qty: 2, status: '조리 대기', createdAt: '10:12' },
  { id: 'KDS-002', menu: '베이컨 치즈 버거', qty: 1, status: '조리 중', createdAt: '10:18' },
  { id: 'KDS-003', menu: '치즈스틱 세트', qty: 3, status: '완료 대기', createdAt: '10:24' },
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
  const [noiseEngine, setNoiseEngine] = useState('대기 중');
  const [loading, setLoading] = useState(false);
  const [aiResponsePending, setAiResponsePending] = useState(false);
  const [responseDelayTriggered, setResponseDelayTriggered] = useState(false);
  const [needSnapshotTouch, setNeedSnapshotTouch] = useState(false);
  const [ageEstimate, setAgeEstimate] = useState(null);
  const [highContrast, setHighContrast] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [snapshotStatus, setSnapshotStatus] = useState('대기 중');
  const [paymentStatus, setPaymentStatus] = useState('결제 위젯을 준비하지 않았습니다.');
  const [paymentError, setPaymentError] = useState('');
  const [isPaymentWidgetLoading, setIsPaymentWidgetLoading] = useState(false);
  const [isPaymentWidgetReady, setIsPaymentWidgetReady] = useState(false);

  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const paymentWidgetRef = useRef(null);
  const workerRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const responseTimeoutRef = useRef(null);
  const responseLoadingTimerRef = useRef(null);
  const ttsActiveRef = useRef(false);
  const ttsUtteranceRef = useRef(null);
  const lastAudioHashRef = useRef('');
  const snapshotCaptureInProgressRef = useRef(false);

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
    workerRef.current = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
    workerRef.current.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'engine-ready') {
        setNoiseEngine(data.engine === 'wasm' ? 'WASM 모듈' : 'JS 폴백');
        return;
      }
      if (data?.type === 'noise-reduced') {
        setNoiseEngine(data.engine === 'wasm' ? 'WASM 모듈' : 'JS 폴백');
        sendAudioToServer(data.pcm);
      }
    };

    connectWebSocket();

    return () => {
      stopVoiceStreaming(false);
      workerRef.current?.terminate();
      wsRef.current?.close();
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(responseTimeoutRef.current);
      clearTimeout(responseLoadingTimerRef.current);
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

  // 에코 루프 방지: TTS 안내 멘트 재생 구간에는 마이크 캡처를 멈춰
  // 키오스크 스피커 출력이 마이크로 재유입되는 것을 차단하고, 재생 후 재개한다.
  //  - 캡처 트랙을 비활성화해 AudioWorklet 이 무음만 받도록 하고
  //  - 캡처 프레임 전달 게이트(ttsActiveRef)로 한 번 더 차단한다.
  const pauseMicForTts = () => {
    ttsActiveRef.current = true;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
  };

  const resumeMicAfterTts = () => {
    ttsActiveRef.current = false;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
  };

  const speak = (text) => {
    setMessage(text);
    if (!ttsEnabled || !('speechSynthesis' in window)) {
      // TTS 미사용 시에도 직전 재생으로 멈춰 둔 마이크는 복구한다.
      resumeMicAfterTts();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';

    utterance.onstart = () => pauseMicForTts();
    const handleSpeechEnd = () => {
      // 최신 멘트의 종료 이벤트일 때만 재개해, 연속 호출 시 조기 재개를 막는다.
      if (ttsUtteranceRef.current === utterance) {
        ttsUtteranceRef.current = null;
        resumeMicAfterTts();
      }
    };
    utterance.onend = handleSpeechEnd;
    utterance.onerror = handleSpeechEnd;

    ttsUtteranceRef.current = utterance;
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

  // AI 서버 응답 지연 2단계 피드백
  //   3초 초과 -> 로딩 피드백 표시 (사용자에게 처리 중임을 알림)
  //   5초 초과 -> 터치 스냅샷 모드 전환 (오류 확인용 스냅샷 유도)
  const startResponseDelayTimer = () => {
    clearTimeout(responseLoadingTimerRef.current);
    clearTimeout(responseTimeoutRef.current);
    setAiResponsePending(false);
    setResponseDelayTriggered(false);

    responseLoadingTimerRef.current = window.setTimeout(() => {
      setAiResponsePending(true);
      addAuditLog('AI 응답 지연', '3초 초과, 로딩 피드백 표시');
    }, 3000);

    responseTimeoutRef.current = window.setTimeout(() => {
      setResponseDelayTriggered(true);
      setNeedSnapshotTouch(true);
      speak('AI 서버 응답이 지연되고 있습니다. 화면을 터치하면 오류 확인용 스냅샷을 전송합니다.');
      addAuditLog('AI 응답 지연', '5초 초과, 터치 스냅샷 요청');
    }, 5000);
  };

  const clearResponseDelay = () => {
    clearTimeout(responseLoadingTimerRef.current);
    clearTimeout(responseTimeoutRef.current);
    setAiResponsePending(false);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };

  const startVoiceStreaming = async () => {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true, // 브라우저 AEC: 에코 루프 방지
          noiseSuppression: false, // 노이즈 캔슬링은 WASM 모듈이 담당
          autoGainControl: true,
        },
      });
      streamRef.current = audioStream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      let audioContext;
      try {
        audioContext = new AudioCtx({ sampleRate: 16000 });
      } catch {
        audioContext = new AudioCtx();
      }
      audioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') await audioContext.resume();

      const { sampleRate } = audioContext;
      workerRef.current?.postMessage({ type: 'configure', sampleRate });

      // AudioWorklet: 마이크 원시 PCM(Float32)을 프레임 단위로 캡처
      await audioContext.audioWorklet.addModule('/pcm-capture-processor.js');

      const source = audioContext.createMediaStreamSource(audioStream);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
        processorOptions: { frameSize: 4096 },
      });
      sourceNodeRef.current = source;
      workletNodeRef.current = workletNode;

      // 캡처된 PCM 프레임 -> Web Worker(WASM 노이즈 캔슬링) -> AI 서버
      workletNode.port.onmessage = (event) => {
        // 에코 루프 방지: TTS 안내 멘트 재생 중 캡처된 프레임은 전송하지 않는다.
        if (ttsActiveRef.current) return;
        const frame = event.data;
        workerRef.current?.postMessage({ type: 'reduce-noise', pcm: frame }, [frame.buffer]);
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination); // 무음 출력, 그래프 활성 유지

      setIsRecording(true);
      setError('');
      speak('음성 인식을 시작했습니다. 원하는 메뉴를 말씀해 주세요.');
    } catch {
      stopVoiceStreaming(false);
      setError('마이크 권한이 필요합니다. 브라우저 권한을 허용한 뒤 다시 시도하세요.');
      speak('마이크 권한이 필요합니다.');
    }
  };

  const stopVoiceStreaming = (announce = true) => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
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
      return allMenuItems.filter((item) => ['cheese-burger', 'fries', 'cola'].includes(item.id));
    }

    const cartIds = new Set(cartItems.map((item) => item.id));
    const rules = [
      { when: ['classic-burger'], then: 'fries', confidence: 0.82 },
      { when: ['cheese-burger'], then: 'cola', confidence: 0.78 },
      { when: ['bulgogi-burger'], then: 'sprite', confidence: 0.77 },
      { when: ['bacon-cheese-burger'], then: 'onion-rings', confidence: 0.76 },
      { when: ['double-bulgogi-burger'], then: 'cheese-sticks', confidence: 0.79 },
      { when: ['steak-burger'], then: 'crispy-tender', confidence: 0.81 },
      { when: ['chicken-burger'], then: 'nuggets', confidence: 0.74 },
      { when: ['fries', 'nuggets'], then: 'zero-cola', confidence: 0.71 },
      { when: ['cheese-sticks', 'crispy-tender'], then: 'zero-sprite', confidence: 0.72 },
      { when: ['cola', 'zero-cola'], then: 'fries', confidence: 0.68 },
      { when: ['sprite', 'zero-sprite'], then: 'cheese-sticks', confidence: 0.66 },
      { when: ['orange-fanta', 'grape-fanta'], then: 'crispy-tender', confidence: 0.65 },
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
    if (snapshotCaptureInProgressRef.current) return;

    let videoStream;
    try {
      snapshotCaptureInProgressRef.current = true;
      setLoading(true);
      setSnapshotStatus('카메라 준비 중');
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true });

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
    } catch (err) {
      setNeedSnapshotTouch(false);
      setAiResponsePending(false);
      setResponseDelayTriggered(false);

      const isPermissionDenied =
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';

      if (isPermissionDenied) {
        setSnapshotStatus('카메라 권한 거부됨');
        setError('카메라 권한이 거부되어 자동 스냅샷 요청을 중지했습니다.');
        speak('카메라 권한이 거부되어 스냅샷 요청을 중지했습니다.');
      } else {
        setSnapshotStatus('전송 실패');
        setError('카메라 권한 또는 AI 서버 연결을 확인해 주세요.');
        speak('스냅샷 전송에 실패했습니다.');
      }
    } finally {
      videoStream?.getTracks().forEach((track) => track.stop());
      snapshotCaptureInProgressRef.current = false;
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
      setPaymentError('');
      setIsPaymentWidgetReady(false);
      setIsPaymentWidgetLoading(true);
      setPaymentStatus('토스페이먼츠 결제 위젯을 불러오는 중입니다.');

      document.querySelector('#payment-widget')?.replaceChildren();
      document.querySelector('#agreement-widget')?.replaceChildren();

      const paymentWidget = await loadPaymentWidget(
        'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm',
        `voice-kiosk-${Date.now()}`,
      );

      paymentWidgetRef.current = paymentWidget;
      paymentWidget.renderPaymentMethods('#payment-widget', totalPrice);
      paymentWidget.renderAgreement?.('#agreement-widget');
      setIsPaymentWidgetReady(true);
      setPaymentStatus('결제 수단을 선택한 뒤 결제 요청을 진행할 수 있습니다.');
    } catch (err) {
      console.error(err);
      setIsPaymentWidgetReady(false);
      setPaymentStatus('결제 위젯을 불러오지 못했습니다.');
      setPaymentError('SDK 스크립트 로드, 테스트 클라이언트 키, 네트워크 상태를 확인해 주세요.');
    } finally {
      setIsPaymentWidgetLoading(false);
    }
  };

  const requestTossPayment = async () => {
    if (!paymentWidgetRef.current || !cart.length) return;

    try {
      setPaymentError('');
      setPaymentStatus('결제 승인 화면으로 이동합니다.');
      await paymentWidgetRef.current.requestPayment({
        orderId: `voice-order-${Date.now()}`,
        orderName: cart.length === 1 ? cart[0].name : `${cart[0].name} 외 ${cart.length - 1}건`,
        successUrl: `${window.location.origin}/success`,
        failUrl: `${window.location.origin}/fail`,
        customerName: '키오스크 고객',
      });
    } catch (err) {
      console.error(err);
      setPaymentStatus('결제 요청을 완료하지 못했습니다.');
      setPaymentError('결제창이 차단되었거나 위젯 선택이 완료되지 않았을 수 있습니다.');
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
      <div>노이즈 캔슬링: {noiseEngine}</div>
      <div>스냅샷: {snapshotStatus}</div>
      {aiResponsePending && !responseDelayTriggered && (
        <span className="pending-tag">AI 응답 대기 중…</span>
      )}
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
      {paymentError && <p className="error">{paymentError}</p>}
      <div className="payment-shell">
        {isPaymentWidgetLoading && (
          <div className="payment-placeholder">
            결제 위젯을 불러오는 중입니다. 잠시만 기다려 주세요.
          </div>
        )}
        {!isPaymentWidgetLoading && !isPaymentWidgetReady && (
          <div className="payment-placeholder">
            아래 버튼을 누르면 토스페이먼츠 SDK 결제수단 UI가 이 영역에 표시됩니다.
          </div>
        )}
        <div id="payment-widget" className="payment-widget" />
        <div id="agreement-widget" className="payment-widget agreement-widget" />
      </div>
      <div className="action-row">
        <button onClick={() => setCurrentScreen('cart')}>장바구니로 돌아가기</button>
        <button disabled={!cart.length || isPaymentWidgetLoading} onClick={handlePayment}>
          결제 위젯 불러오기
        </button>
        <button className="primary" disabled={!isPaymentWidgetReady} onClick={requestTossPayment}>
          SDK 결제 요청
        </button>
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
      {aiResponsePending && (
        <div className="loading ai-pending" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          AI가 주문을 인식하고 있어요…
        </div>
      )}
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
