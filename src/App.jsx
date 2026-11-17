import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { loadPaymentWidget } from '@tosspayments/payment-widget-sdk';
import { apiClient } from './api/client.js';
import { kioskApi } from './api/kiosk.js';
import { normalizeMenus, groupMenus, createCartItem, addCartItem, getOptionGroups, orderStatusLabel, isPaidOrder, cartFingerprint } from './domain/kiosk.js';
import { createCheckoutManager } from './domain/checkout.js';
import { removePaidItemsFromCart } from './domain/cart-settlement.js';
import { runtimeConfig } from './integration/runtime.js';
import { openKdsStream } from './integration/sse.js';
import { browserSessionStorage, readSession, saveSession, clearSession } from './integration/session.js';
import { changedKdsIds, mergeKdsOrders } from './integration/kds-state.js';
import { koreaToday } from './integration/date.js';
import { assertTestWidgetKey, prepareTossWidget, readPaymentReturn } from './integration/payment.js';
import { describePaymentError } from './integration/payment-error.js';

const AI_WS_URL = runtimeConfig.aiWsUrl;
const LOCAL_MOCK_PAYMENT = import.meta.env.MODE === 'local-mock'
  && ['127.0.0.1', 'localhost'].includes(globalThis.window?.location?.hostname);

const fallbackMenuCatalog = [
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

const statusLabel = {
  connecting: '연결 중',
  open: '연결됨',
  closed: '연결 끊김',
  error: '오류',
};

const formatPrice = (value) => `${Number(value ?? 0).toLocaleString('ko-KR')}원`;
const cleanName = (name) => String(name || '').replace(/\s/gu, '');
const toKdsCard = (order) => {
  if (!Number.isSafeInteger(order?.orderId) || order.orderId <= 0 || !Array.isArray(order.items)) throw new Error('주문 응답 형식을 확인해 주세요.');
  return {
    ...order, id: order.orderId, number: order.orderNumber,
    menu: order.items.map((item) => `${item.menuNameKo} ${item.quantity}개${item.optionNames?.length ? ` (${item.optionNames.join(', ')})` : ''}`).join(', '),
    qty: order.items.reduce((total, item) => total + item.quantity, 0),
    createdAt: new Date(order.orderedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
  };
};

function App() {
  const checkoutRef = useRef(null);
  if (!checkoutRef.current) checkoutRef.current = createCheckoutManager({ api: kioskApi, storage: browserSessionStorage });
  const [menuCatalog, setMenuCatalog] = useState(fallbackMenuCatalog);
  const [adminMenuItems, setAdminMenuItems] = useState([]);
  const [menuSource, setMenuSource] = useState('sample');
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState('');
  const [optionSelections, setOptionSelections] = useState({});
  const [currentScreen, setCurrentScreen] = useState('menu');
  const [selectedCategory, setSelectedCategory] = useState(fallbackMenuCatalog[0].id);
  const [cart, setCart] = useState(() => checkoutRef.current.getSaved()?.phase === 'paid' ? [] : checkoutRef.current.restoreCart());
  const [recommendations, setRecommendations] = useState([]);
  const [kdsOrders, setKdsOrders] = useState([]);
  const [adminLogs, setAdminLogs] = useState([]);
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
  const [paymentStatus, setPaymentStatus] = useState('결제 수단을 준비하고 있습니다.');
  const [paymentError, setPaymentError] = useState('');
  const [isPaymentWidgetLoading, setIsPaymentWidgetLoading] = useState(false);
  const [isPaymentWidgetReady, setIsPaymentWidgetReady] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [receiptOrderId, setReceiptOrderId] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [session, setSession] = useState(() => readSession());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [kdsError, setKdsError] = useState('');
  const [kdsStreamStatus, setKdsStreamStatus] = useState('closed');
  const [kdsLoading, setKdsLoading] = useState(false);
  const [kdsUpdating, setKdsUpdating] = useState(null);
  const [adminData, setAdminData] = useState({ orders: [], payments: [], sales: null, popular: [] });
  const [adminError, setAdminError] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminAction, setAdminAction] = useState(null);
  const [statsFrom, setStatsFrom] = useState(() => koreaToday());
  const [statsTo, setStatsTo] = useState(() => koreaToday());


  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const voiceStartingRef = useRef(false);
  const voiceGenerationRef = useRef(0);
  const videoRef = useRef(null);
  const paymentWidgetRef = useRef(null);
  const paymentPreparationRef = useRef(null);
  const paymentFingerprintRef = useRef(null);
  const paymentReturnRef = useRef(readPaymentReturn(globalThis.window?.location));
  const paymentReturnStartedRef = useRef(false);
  const receiptStateRef = useRef(null);
  if (!receiptStateRef.current || typeof receiptStateRef.current !== 'object') {
    receiptStateRef.current = { revision: 0, settledOrderIds: new Set() };
  }
  const workerRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const responseTimeoutRef = useRef(null);
  const responseLoadingTimerRef = useRef(null);
  const ttsActiveRef = useRef(false);
  const ttsUtteranceRef = useRef(null);
  const appMountedRef = useRef(false);
  const retryCountRef = useRef(0);
  const awaitingAiRef = useRef(false);
  const aiMessageHandlerRef = useRef(null);
  const speakRef = useRef(null);
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;
  const menuRequestRef = useRef(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const paymentBusyRef = useRef(false);
  const authBusyRef = useRef(false);
  const kdsActionRef = useRef(false);
  const kdsRevisionRef = useRef(0);
  const kdsVersionsRef = useRef(new Map());
  const kdsClosedIdsRef = useRef(new Set());
  const kdsRequestRef = useRef(0);
  const kdsOrdersRef = useRef(kdsOrders);
  kdsOrdersRef.current = kdsOrders;
  const adminActionRef = useRef(false);
  const adminLoadingRef = useRef(false);
  const adminMenuItemsRef = useRef(adminMenuItems);
  adminMenuItemsRef.current = adminMenuItems;
  const allMenuItems = useMemo(() => menuCatalog.flatMap((category) => category.items), [menuCatalog]);
  const menuItemsRef = useRef(allMenuItems);
  menuItemsRef.current = allMenuItems;
  const menuSourceRef = useRef(menuSource);
  menuSourceRef.current = menuSource;
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
    () => (menuCatalog.find((category) => category.id === selectedCategory)?.items || []).filter((item) => item.status !== 'INACTIVE'),
    [selectedCategory, menuCatalog],
  );

  const getPendingTossReturn = () => checkoutRef.current.getPendingTossReturn?.(
    paymentReturnRef.current?.type === 'success' ? paymentReturnRef.current : undefined,
  ) || null;
  const hasAuthenticatedPayment = Boolean(getPendingTossReturn());
  const savedCheckout = checkoutRef.current.getSaved();
  let paymentInfo = paymentOrder;
  if (!paymentInfo && savedCheckout?.order) {
    try {
      if (hasAuthenticatedPayment || savedCheckout.fingerprint === cartFingerprint(cart)) paymentInfo = savedCheckout.order;
    } catch { /* Corrupt stored cart data is handled by checkout validation. */ }
  }

  useEffect(() => {
    appMountedRef.current = true;
    loadMenus();
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
      appMountedRef.current = false;
      menuRequestRef.current?.abort();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onopen = null;
        wsRef.current.onerror = null;
      }
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
  }, [cart, menuCatalog]);

  useEffect(() => {
    paymentPreparationRef.current?.abort();
    paymentWidgetRef.current?.dispose();
    setIsPaymentWidgetReady(false);
    paymentWidgetRef.current = null;
    setPaymentOrder(null);
    document.querySelector('#payment-widget')?.replaceChildren();
    document.querySelector('#agreement-widget')?.replaceChildren();
  }, [cart]);

  useEffect(() => {
    if (!ageEstimate || paymentBusyRef.current || currentScreen === 'payment') return;
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
    if (!ttsEnabledRef.current || !('speechSynthesis' in window)) {
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
    if (!AI_WS_URL || !appMountedRef.current) return;
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(wsRef.current?.readyState)) return;
    clearTimeout(reconnectTimerRef.current);
    setWsStatus('connecting');
    const websocket = new WebSocket(AI_WS_URL);
    wsRef.current = websocket;
    const current = () => appMountedRef.current && wsRef.current === websocket;
    websocket.onopen = () => {
      if (!current()) return;
      retryCountRef.current = 0;
      setWsStatus('open');
      setRetryCount(0);
      speakRef.current?.('AI 서버와 연결되었습니다. 음성 주문을 시작할 수 있습니다.');
      addAuditLog('WebSocket 연결', '음성 서버 연결');
    };
    websocket.onmessage = (event) => {
      if (!current()) return;
      clearResponseDelay();
      aiMessageHandlerRef.current?.(event.data);
    };
    websocket.onerror = () => {
      if (!current()) return;
      setWsStatus('error');
      setError('AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.');
    };
    websocket.onclose = () => {
      if (!current()) return;
      setWsStatus('closed');
      if (retryCountRef.current >= 5) return;
      retryCountRef.current += 1;
      setRetryCount(retryCountRef.current);
      reconnectTimerRef.current = window.setTimeout(connectWebSocket, retryCountRef.current * 2000);
    };
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

    if (data.type === 'order' && data.item && currentScreen !== 'payment') {
      addToCart(data.item);
    }

    if (data.type === 'age_estimate' && Number.isFinite(data.age) && data.age >= 0 && data.age <= 120) {
      setAgeEstimate(data.age);
    }

    if (data.type === 'recommendation') {
      const items = Array.isArray(data.items) ? data.items.map((item) => {
        const known = resolveMenu(item);
        return known ? { ...known, confidence: item.confidence } : null;
      }).filter(Boolean) : [];
      setRecommendations(items);
      if (!paymentBusyRef.current && currentScreen !== 'payment') setCurrentScreen('recommendations');
    }

    if (data.type === 'kds_status' && data.order) {
      // Kitchen order authority belongs to the authenticated backend SSE stream.
      addAuditLog('AI 상태 수신', '주방 주문 상태는 주문 서버에서 확인합니다.');
    }
  };

  // AI 서버 응답 지연 2단계 피드백
  //   3초 초과 -> 로딩 피드백 표시 (사용자에게 처리 중임을 알림)
  //   5초 초과 -> 터치 스냅샷 모드 전환 (오류 확인용 스냅샷 유도)
  const startResponseDelayTimer = () => {
    if (awaitingAiRef.current) return;
    awaitingAiRef.current = true;
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
    awaitingAiRef.current = false;
    clearTimeout(responseLoadingTimerRef.current);
    clearTimeout(responseTimeoutRef.current);
    setAiResponsePending(false);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };

  const startVoiceStreaming = async () => {
    if (streamRef.current || voiceStartingRef.current || paymentBusyRef.current) return;
    voiceStartingRef.current = true;
    const generation = ++voiceGenerationRef.current;
    const current = () => appMountedRef.current && voiceGenerationRef.current === generation;
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true, // 브라우저 AEC: 에코 루프 방지
          noiseSuppression: false, // 노이즈 캔슬링은 WASM 모듈이 담당
          autoGainControl: true,
        },
      });
      if (!current()) { audioStream.getTracks().forEach((track) => track.stop()); return; }
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
      if (!current()) return;

      const { sampleRate } = audioContext;
      if (sampleRate !== 16000) throw new Error('이 기기의 오디오 형식은 음성 서버 확인이 필요합니다.');
      workerRef.current?.postMessage({ type: 'configure', sampleRate });

      // AudioWorklet: 마이크 원시 PCM(Float32)을 프레임 단위로 캡처
      await audioContext.audioWorklet.addModule('/pcm-capture-processor.js');
      if (!current()) return;

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
    } catch (failure) {
      if (!current()) return;
      stopVoiceStreaming(false);
      setError(failure.message || '마이크 권한이 필요합니다. 브라우저 권한을 허용한 뒤 다시 시도하세요.');
      speak('마이크 권한 또는 오디오 설정을 확인해 주세요.');
    } finally {
      if (voiceGenerationRef.current === generation) voiceStartingRef.current = false;
    }
  };

  const stopVoiceStreaming = (announce = true) => {
    voiceGenerationRef.current += 1;
    voiceStartingRef.current = false;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearResponseDelay();
    setIsRecording(false);
    if (announce) speak('음성 인식을 종료했습니다.');
  };

  const sendAudioToServer = async (buffer) => {
    if (!buffer) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer);
      startResponseDelayTimer();
      return;
    }

    setError('AI 서버가 연결되지 않아 음성 데이터는 전송하지 못했습니다.');
  };

  const resolveMenu = (candidate) => {
    const menus = menuItemsRef.current;
    const id = candidate?.menuId ?? candidate?.id;
    if (Number.isSafeInteger(id)) return menus.find((item) => item.menuId === id);
    const matches = menus.filter((item) => cleanName(item.name) === cleanName(candidate?.name ?? candidate?.nameKo));
    return matches.length === 1 ? matches[0] : null;
  };

  const addToCart = (candidate) => {
    if (paymentBusyRef.current) return;
    try {
      if (menuSourceRef.current !== 'server') throw new Error('서버 메뉴를 불러온 뒤 주문할 수 있습니다.');
      const menu = resolveMenu(candidate);
      if (!menu) throw new Error('주문할 메뉴를 서버 목록에서 확인할 수 없습니다.');
      const item = createCartItem(menu, optionSelections[menu.menuId] || candidate.optionIds || []);
      checkoutRef.current.clearPaid();
      setCart((prev) => addCartItem(prev, item));
      setError('');
      speak(`${item.name}을 장바구니에 담았습니다.`);
    } catch (failure) { setError(failure.message); }
  };

  const removeFromCart = (lineId) => {
    if (!paymentBusyRef.current) setCart((prev) => prev.filter((item) => item.lineId !== lineId));
  };

  const updateQuantity = (lineId, quantity) => {
    if (paymentBusyRef.current || !Number.isSafeInteger(quantity)) return;
    if (quantity <= 0) { removeFromCart(lineId); return; }
    setCart((prev) => prev.map((item) => item.lineId === lineId ? { ...item, quantity } : item));
  };

  const selectOption = (menu, optionId, selected) => {
    const sauces = new Set(getOptionGroups(menu).sauces.map((option) => option.optionId));
    setOptionSelections((prev) => {
      let next = [...(prev[menu.menuId] || [])].filter((id) => id !== optionId);
      if (selected && sauces.has(optionId)) next = next.filter((id) => !sauces.has(id));
      if (selected) next.push(optionId);
      return { ...prev, [menu.menuId]: next };
    });
  };

  const buildRecommendations = (cartItems) => {
    const menus = menuItemsRef.current.filter((item) => item.status === 'ACTIVE');
    if (!cartItems.length) return menus.slice(0, 3);
    const samples = fallbackMenuCatalog.flatMap((category) => category.items);
    const serverForSlug = (slug) => menus.find((item) => cleanName(item.name) === cleanName(samples.find((sample) => sample.id === slug)?.name));

    const cartIds = new Set(cartItems.map((item) => item.menuId));
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

    const matched = rules
      .filter((rule) => rule.when.some((slug) => cartIds.has(serverForSlug(slug)?.menuId)))
      .map((rule) => ({ menu: serverForSlug(rule.then), confidence: rule.confidence }))
      .filter(({ menu }) => menu && !cartIds.has(menu.menuId))
      .map(({ menu, confidence }) => ({ ...menu, confidence }));
    return matched.length ? [...new Map(matched.map((item) => [item.menuId, item])).values()]
      : menus.filter((item) => !cartIds.has(item.menuId)).slice(0, 3);
  };

  const captureSnapshot = async () => {
    if (snapshotCaptureInProgressRef.current || paymentBusyRef.current) return;
    if (!runtimeConfig.aiSnapshotUrl) {
      setSnapshotStatus('연결 확인 필요');
      setError('사진 분석 서버의 요청 형식과 주소를 확인하고 있습니다.');
      setNeedSnapshotTouch(false);
      return;
    }

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
      const response = await fetch(runtimeConfig.aiSnapshotUrl, {
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
    if (currentScreen === 'menu' && needSnapshotTouch) captureSnapshot();
  };

  const submitOrderToKds = () => { if (cart.length && !paymentBusyRef.current) setCurrentScreen('payment'); };

  const updateKdsStatus = async (id, status) => {
    if (kdsActionRef.current || !sessionRef.current || !['PREPARING', 'COMPLETED'].includes(status)) return;
    const token = sessionRef.current.accessToken;
    kdsActionRef.current = true;
    setKdsUpdating(id);
    setKdsError('');
    try {
      await kioskApi.updateKdsStatus(id, status, { token });
      if (sessionRef.current?.accessToken !== token) return;
      kdsRevisionRef.current += 1;
      kdsVersionsRef.current.set(id, kdsRevisionRef.current);
      if (status === 'COMPLETED') kdsClosedIdsRef.current.add(id);
      setKdsOrders((prev) => status === 'COMPLETED' ? prev.filter((order) => order.id !== id)
        : prev.map((order) => order.id === id ? { ...order, status } : order));
      addAuditLog('KDS 상태 변경', `${id} → ${orderStatusLabel(status)}`, sessionRef.current.role);
    } catch (failure) { setKdsError(failure.message); }
    finally { kdsActionRef.current = false; setKdsUpdating(null); }
  };

  const simulateAgeEstimate = () => {
    const age = [18, 24, 32, 46, 61][Math.floor(Math.random() * 5)];
    setAgeEstimate(age);
  };

  const finishPayment = (order) => {
    if (!isPaidOrder(order)) throw new Error('결제 완료 상태를 확인할 수 없습니다.');
    receiptStateRef.current.revision += 1;
    setPaymentError('');
    setReceiptError('');
    setReceipt(order);
    if (!receiptStateRef.current.settledOrderIds.has(order.orderId)) {
      receiptStateRef.current.settledOrderIds.add(order.orderId);
      setCart((prev) => removePaidItemsFromCart(prev, order.items));
    }
    setPaymentStatus('결제가 완료되었습니다.');
    setCurrentScreen('kds');
    addAuditLog('결제 완료', order.orderNumber);
    speak('결제가 완료되었습니다. 주문이 접수되었습니다.');
  };

  const clearPaymentReturnUrl = () => {
    if (['/payment/success', '/payment/fail'].includes(window.location.pathname)) {
      try { window.history.replaceState(window.history.state, '', '/'); } catch { /* Approval must not depend on browser history access. */ }
    }
  };

  const acceptReceipt = (order, previousCheckout) => {
    const saved = checkoutRef.current.getSaved();
    const matchesCheckout = saved?.order?.orderId === order.orderId
      && previousCheckout?.order?.orderId === order.orderId;
    if (matchesCheckout && ['paid', 'closed'].includes(saved.phase)) {
      if (paymentReturnRef.current?.orderNumber === order.orderNumber) {
        paymentReturnRef.current = null;
        clearPaymentReturnUrl();
      }
      if (saved.phase === 'paid' && isPaidOrder(order) && !receiptStateRef.current.settledOrderIds.has(order.orderId)) {
        finishPayment(order);
        return;
      }
    }
    setReceipt(order);
  };

  const completeTossPayment = async (result) => {
    if (paymentBusyRef.current) return;
    paymentReturnRef.current = result;
    paymentBusyRef.current = true;
    setCheckoutBusy(true);
    setPaymentError('');
    setIsPaymentWidgetReady(false);
    setPaymentStatus('결제 승인과 주문 상태를 확인하고 있습니다.');
    try {
      assertTestWidgetKey(import.meta.env.VITE_TOSS_CLIENT_KEY || '');
      const order = await checkoutRef.current.confirmToss(result);
      if (!appMountedRef.current) return;
      paymentReturnRef.current = null;
      finishPayment(order);
      clearPaymentReturnUrl();
    } catch (failure) {
      if (!appMountedRef.current) return;
      const details = describePaymentError(failure, { afterAuthentication: true, paymentKey: result.paymentKey });
      const saved = checkoutRef.current.getSaved();
      if (saved?.phase === 'closed') {
        paymentReturnRef.current = null;
        clearPaymentReturnUrl();
      }
      setPaymentStatus(details.title);
      setPaymentError(details);
      setPaymentOrder(saved?.order || null);
    } finally {
      if (appMountedRef.current) {
        paymentBusyRef.current = false;
        setCheckoutBusy(false);
        // A failed lookup must not discard authentication, including when the
        // browser refuses storage. The success path removes the return URL.
      }
    }
  };

  const handlePayment = async () => {
    if (!cartRef.current.length || paymentBusyRef.current) return;
    const pending = getPendingTossReturn();
    if (pending) {
      paymentReturnRef.current = pending;
      setPaymentOrder(checkoutRef.current.getSaved()?.order || null);
      setIsPaymentWidgetReady(false);
      setIsPaymentWidgetLoading(false);
      setPaymentStatus('이전 결제 인증 결과가 남아 있습니다. 아래 버튼으로 결제 결과를 확인해 주세요.');
      return;
    }
    if (paymentReturnRef.current) clearPaymentReturnUrl();
    paymentReturnRef.current = null;
    paymentPreparationRef.current?.abort();
    paymentWidgetRef.current?.dispose();
    paymentWidgetRef.current = null;
    const controller = new AbortController();
    paymentPreparationRef.current = controller;
    const current = () => !controller.signal.aborted && appMountedRef.current;
    try {
      setPaymentError('');
      setIsPaymentWidgetReady(false);
      setPaymentOrder(null);
      setIsPaymentWidgetLoading(true);
      setPaymentStatus('주문과 결제 수단을 준비하고 있습니다.');
      const key = import.meta.env.VITE_TOSS_CLIENT_KEY || '';
      if (!LOCAL_MOCK_PAYMENT) assertTestWidgetKey(key);
      if (checkoutRef.current.getSaved()?.phase === 'closed') checkoutRef.current.beginNewCheckout();
      const fingerprint = cartFingerprint(cartRef.current);
      const order = await checkoutRef.current.prepare(cartRef.current);
      if (!current()) return;
      if (isPaidOrder(order)) { finishPayment(order); return; }
      paymentFingerprintRef.current = fingerprint;
      setPaymentOrder(order);
      document.querySelector('#payment-widget')?.replaceChildren();
      document.querySelector('#agreement-widget')?.replaceChildren();
      if (!LOCAL_MOCK_PAYMENT) {
        const widget = await prepareTossWidget({ key, order, loadWidget: loadPaymentWidget, signal: controller.signal });
        if (!current()) { widget.dispose(); return; }
        paymentWidgetRef.current = widget;
      }
      setIsPaymentWidgetReady(true);
      setPaymentStatus(LOCAL_MOCK_PAYMENT ? '주문 금액을 확인한 뒤 결제하기를 눌러 주세요.'
        : '신용·체크카드 또는 카카오·네이버·토스페이를 선택하고, 필수 약관에 동의한 뒤 결제하기를 눌러 주세요.');
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      setIsPaymentWidgetReady(false);
      const details = describePaymentError(failure);
      setPaymentStatus(details.title);
      setPaymentError(details);
      document.querySelector('#payment-widget')?.replaceChildren();
      document.querySelector('#agreement-widget')?.replaceChildren();
    } finally { if (current()) setIsPaymentWidgetLoading(false); }
  };

  const requestTossPayment = async () => {
    if (paymentBusyRef.current || isPaymentWidgetLoading) return;
    const pending = getPendingTossReturn();
    if (pending) { await completeTossPayment(pending); return; }
    if (!cartRef.current.length) return;
    if (!isPaymentWidgetReady || !paymentOrder) { await handlePayment(); return; }
    paymentBusyRef.current = true;
    setCheckoutBusy(true);
    setPaymentError('');
    try {
      if (paymentFingerprintRef.current !== cartFingerprint(cartRef.current)) throw new Error('장바구니가 변경되었습니다. 결제 화면을 다시 열어 주세요.');
      if (LOCAL_MOCK_PAYMENT) {
        finishPayment(await checkoutRef.current.payTest(cartRef.current));
        paymentBusyRef.current = false;
        setCheckoutBusy(false);
        return;
      }
      assertTestWidgetKey(import.meta.env.VITE_TOSS_CLIENT_KEY || '');
      setPaymentStatus('결제 인증을 진행해 주세요.');
      await paymentWidgetRef.current.request({
        origin: window.location.origin,
        onRequest: (request) => checkoutRef.current.markTossRequested(request),
      });
      // Redirect mode returns to /payment/success or /payment/fail on both desktop and mobile.
      // Keep the request locked until navigation; an authentication result is not approval.
    } catch (failure) {
      setPaymentStatus('결제를 진행하지 못했습니다. 결제 수단을 확인한 뒤 다시 시도해 주세요.');
      setPaymentError(failure.code === 'USER_CANCEL' ? '결제를 취소했습니다.' : describePaymentError(failure));
      paymentBusyRef.current = false;
      setCheckoutBusy(false);
    }
  };

  useEffect(() => {
    if (currentScreen !== 'payment' || paymentReturnRef.current) return undefined;
    handlePayment();
    return () => {
      paymentPreparationRef.current?.abort();
      paymentWidgetRef.current?.dispose();
      paymentWidgetRef.current = null;
    };
  }, [currentScreen, cart]);

  useEffect(() => {
    const result = paymentReturnRef.current;
    if (!result || paymentReturnStartedRef.current) return;
    paymentReturnStartedRef.current = true;
    setCurrentScreen('payment');
    if (result.type !== 'success') {
      setPaymentStatus('결제를 완료하지 못했습니다.');
      setPaymentError(result.message);
      clearPaymentReturnUrl();
      return;
    }
    completeTossPayment(result);
  }, []);

  useEffect(() => () => {
    // Keep a failed callback visible on its first screen, then allow automatic
    // widget preparation again when the user leaves and reopens payment.
    if (currentScreen === 'payment' && !paymentBusyRef.current && paymentReturnRef.current?.type !== 'success') paymentReturnRef.current = null;
  }, [currentScreen]);

  const loadMenus = async () => {
    menuRequestRef.current?.abort();
    const controller = new AbortController();
    menuRequestRef.current = controller;
    setMenuLoading(true);
    setMenuError('');
    try {
      const menus = normalizeMenus(await kioskApi.fetchMenus({ signal: controller.signal }));
      if (controller.signal.aborted || !appMountedRef.current) return;
      const categories = groupMenus(menus);
      adminMenuItemsRef.current = menus;
      setAdminMenuItems(menus);
      setMenuCatalog(categories);
      setMenuSource('server');
      setSelectedCategory((selected) => categories.some((category) => category.id === selected) ? selected : categories[0]?.id || '');
      setOptionSelections({});
    } catch (failure) {
      if (!controller.signal.aborted && appMountedRef.current) setMenuError(`메뉴 서버: ${failure.message}`);
    } finally {
      if (!controller.signal.aborted && appMountedRef.current) setMenuLoading(false);
    }
  };

  useEffect(() => {
    if (paymentReturnRef.current) return undefined;
    let active = true;
    const revision = receiptStateRef.current.revision;
    const saved = checkoutRef.current.getSaved();
    if (saved?.order?.orderId) {
      checkoutRef.current.readReceipt(saved.order.orderId).then((order) => {
        if (active && revision === receiptStateRef.current.revision) acceptReceipt(order, saved);
      }).catch((failure) => { if (active && revision === receiptStateRef.current.revision) setReceiptError(failure.message); });
    }
    return () => { active = false; };
  }, []);

  const expireSession = (token) => {
    if (token && sessionRef.current?.accessToken !== token) return;
    clearSession();
    sessionRef.current = null;
    setSession(null);
    kdsVersionsRef.current.clear();
    kdsClosedIdsRef.current.clear();
    setKdsOrders([]);
    setAdminData({ orders: [], payments: [], sales: null, popular: [] });
    setAuthError('로그인이 만료되었거나 접근 권한이 없습니다. 다시 로그인해 주세요.');
  };

  useEffect(() => {
    apiClient.configureAuth({
      getAccessToken: () => sessionRef.current?.accessToken,
      onAuthError: (failure) => expireSession(failure.token),
    });
    return () => apiClient.configureAuth({ getAccessToken: () => null, onAuthError: () => {} });
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    let timer;
    const checkExpiry = () => {
      const remaining = session.expiresAt - Date.now();
      if (remaining <= 0) { expireSession(session.accessToken); return; }
      // Browsers overflow a setTimeout delay greater than 2^31-1 milliseconds.
      timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647));
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [session]);

  const login = async (event) => {
    event.preventDefault();
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    setAuthError('');
    try {
      const data = await kioskApi.login({ username, password });
      const next = saveSession(data);
      sessionRef.current = next;
      setSession(next);
      setUsername('');
      addAuditLog('로그인', `${next.role} 세션 시작`, next.role);
    } catch (failure) { setAuthError(failure.message); }
    finally { setPassword(''); authBusyRef.current = false; setAuthBusy(false); }
  };

  const logout = async () => {
    if (authBusyRef.current || adminActionRef.current || kdsActionRef.current || !sessionRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    const token = sessionRef.current.accessToken;
    // This device signs out immediately even when server-side token revocation fails.
    clearSession();
    sessionRef.current = null;
    setSession(null);
    kdsVersionsRef.current.clear();
    kdsClosedIdsRef.current.clear();
    setKdsOrders([]);
    setAdminData({ orders: [], payments: [], sales: null, popular: [] });
    setAuthError('');
    try {
      await kioskApi.logout({ token });
    } catch { setAuthError('이 기기에서는 로그아웃되었습니다. 서버의 토큰 폐기 여부는 확인하지 못했습니다.'); }
    finally { authBusyRef.current = false; setAuthBusy(false); }
  };

  const loadKdsOrders = async ({ signal } = {}) => {
    const token = sessionRef.current?.accessToken;
    if (!token) return;
    const request = ++kdsRequestRef.current;
    const versions = new Map(kdsVersionsRef.current);
    setKdsLoading(true);
    setKdsError('');
    try {
      const data = await kioskApi.fetchKdsOrders({ storeId: runtimeConfig.storeId, token, signal });
      if (!Array.isArray(data)) throw new Error('주방 주문 목록 형식을 확인해 주세요.');
      if (signal?.aborted || request !== kdsRequestRef.current || sessionRef.current?.accessToken !== token) return;
      const cards = data.filter((order) => ['PAID', 'PREPARING'].includes(order.status) && !kdsClosedIdsRef.current.has(order.orderId)).map(toKdsCard);
      const changedIds = changedKdsIds(versions, kdsVersionsRef.current);
      setKdsOrders((prev) => mergeKdsOrders({ serverOrders: cards, currentOrders: prev,
        changedIds, closedIds: kdsClosedIdsRef.current }));
    } catch (failure) {
      if (!signal?.aborted && request === kdsRequestRef.current && sessionRef.current?.accessToken === token) setKdsError(failure.message);
    } finally { if (!signal?.aborted && request === kdsRequestRef.current) setKdsLoading(false); }
  };

  useEffect(() => {
    if (currentScreen !== 'kds' || !session) return undefined;
    const controller = new AbortController();
    const token = session.accessToken;
    loadKdsOrders({ signal: controller.signal });
    const stop = openKdsStream({
      token, storeId: runtimeConfig.storeId, signal: controller.signal,
      onStatus: (status) => {
        if (sessionRef.current?.accessToken !== token) return;
        setKdsStreamStatus(status);
        if (status === 'open') loadKdsOrders({ signal: controller.signal });
      },
      onOrder: (data) => {
        if (sessionRef.current?.accessToken !== token) return;
        try {
          if (kdsClosedIdsRef.current.has(data.orderId)) return;
          const prior = kdsOrdersRef.current.find((item) => item.id === data.orderId);
          const order = toKdsCard({ ...data, status: data.status || prior?.status || 'PAID' });
          kdsRevisionRef.current += 1;
          kdsVersionsRef.current.set(order.id, kdsRevisionRef.current);
          setKdsOrders((prev) => [order, ...prev.filter((item) => item.id !== order.id)]);
        } catch (failure) { setKdsError(failure.message); }
      },
      onAuthError: (failure) => expireSession(failure.token),
      onError: (failure) => { if (sessionRef.current?.accessToken === token) setKdsError(failure.message); },
    });
    return () => { controller.abort(); stop(); };
  }, [currentScreen, session]);

  const loadAdmin = async () => {
    const token = sessionRef.current?.accessToken;
    if (sessionRef.current?.role !== 'ADMIN' || adminLoadingRef.current) return;
    adminLoadingRef.current = true;
    setAdminBusy(true);
    setAdminError('');
    try {
      const parameters = { storeId: runtimeConfig.storeId, token, from: statsFrom, to: statsTo };
      const results = await Promise.allSettled([
        kioskApi.fetchAdminOrders(parameters), kioskApi.fetchAdminPayments(parameters),
        kioskApi.fetchSalesStats(parameters), kioskApi.fetchMenuStats(parameters),
      ]);
      if (sessionRef.current?.accessToken !== token) return;
      const keys = ['orders', 'payments', 'sales', 'popular'];
      const errors = [];
      const updates = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (keys[index] !== 'sales' && !Array.isArray(result.value)) errors.push(`${keys[index]} 응답 형식 확인 필요`);
          else if (keys[index] === 'sales' && result.value != null && (typeof result.value !== 'object' || Array.isArray(result.value))) errors.push('매출 통계 응답 형식 확인 필요');
          else updates[keys[index]] = result.value;
        } else errors.push(result.reason.message);
      });
      setAdminData((prev) => ({ ...prev, ...updates }));
      setAdminError([...new Set(errors)].join(' / '));
    } catch (failure) { setAdminError(failure.message); }
    finally { adminLoadingRef.current = false; setAdminBusy(false); }
  };

  useEffect(() => {
    if (currentScreen === 'admin' && session?.role === 'ADMIN') loadAdmin();
  }, [currentScreen, session]);

  const changeMenuStatus = async (menuId, status) => {
    if (adminActionRef.current || sessionRef.current?.role !== 'ADMIN') return;
    adminActionRef.current = true;
    setAdminAction(menuId);
    setAdminError('');
    const token = sessionRef.current.accessToken;
    try {
      await kioskApi.updateMenuStatus(menuId, status, { token });
      if (sessionRef.current?.accessToken !== token) return;
      const menus = adminMenuItemsRef.current.map((item) => item.menuId === menuId ? { ...item, status } : item);
      adminMenuItemsRef.current = menus;
      setAdminMenuItems(menus);
      const categories = groupMenus(menus);
      setMenuCatalog(categories);
      setSelectedCategory((selected) => categories.some((category) => category.id === selected) ? selected : categories[0]?.id || '');
      addAuditLog('메뉴 상태 변경', `${menuId} → ${status}`, 'ADMIN');
    } catch (failure) { setAdminError(failure.message); }
    finally { adminActionRef.current = false; setAdminAction(null); }
  };

  const showAdminOrder = async (orderId) => {
    if (adminActionRef.current || sessionRef.current?.role !== 'ADMIN') return;
    adminActionRef.current = true;
    setAdminAction(`order-${orderId}`);
    const token = sessionRef.current.accessToken;
    const revision = ++receiptStateRef.current.revision;
    try {
      const order = await kioskApi.getAdminOrder(orderId, { token });
      if (sessionRef.current?.accessToken === token && revision === receiptStateRef.current.revision) { setReceipt(order); setReceiptError(''); }
    } catch (failure) { setAdminError(failure.message); }
    finally { adminActionRef.current = false; setAdminAction(null); }
  };

  const refundPayment = async (payment) => {
    if (adminActionRef.current || sessionRef.current?.role !== 'ADMIN' || payment.pgProvider !== 'TEST') return;
    if (!window.confirm('이 결제를 취소하시겠습니까?')) return;
    adminActionRef.current = true;
    setAdminAction(`payment-${payment.paymentId}`);
    setAdminError('');
    try {
      await kioskApi.cancelPayment({ pgTransactionId: payment.pgTransactionId, cancelReason: '고객 요청' });
      addAuditLog('결제 취소', `주문 ${payment.orderId}`, 'ADMIN');
      await loadAdmin();
      if (receipt?.orderId === payment.orderId) {
        const revision = ++receiptStateRef.current.revision;
        const previousCheckout = checkoutRef.current.getSaved();
        const order = await checkoutRef.current.readReceipt(payment.orderId);
        if (revision === receiptStateRef.current.revision) acceptReceipt(order, previousCheckout);
      }
    } catch (failure) { setAdminError(failure.message); }
    finally { adminActionRef.current = false; setAdminAction(null); }
  };

  const lookupReceipt = async (event) => {
    event.preventDefault();
    if (receiptBusy) return;
    setReceiptBusy(true);
    setReceiptError('');
    const revision = ++receiptStateRef.current.revision;
    const previousCheckout = checkoutRef.current.getSaved();
    try {
      const order = await checkoutRef.current.readReceipt(Number(receiptOrderId));
      if (revision === receiptStateRef.current.revision) acceptReceipt(order, previousCheckout);
    } catch (failure) { if (revision === receiptStateRef.current.revision) setReceiptError(failure.message); }
    finally { setReceiptBusy(false); }
  };

  const renderMenuImage = (item) => item.imageUrl
    ? <img src={item.imageUrl} alt={item.name} loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
    : item.image;

  const renderMenuOptions = (item) => {
    if (!item.options?.length && !item.allergens?.length && !item.nutrient) return null;
    const groups = getOptionGroups(item);
    const selected = optionSelections[item.menuId] || [];
    return <details className="menu-details">
      <summary>메뉴 정보 · 옵션</summary>
      {item.allergens?.length > 0 && <p>알레르기: {item.allergens.join(', ')}</p>}
      {item.nutrient && <p>열량 {item.nutrient.calories ?? '-'}kcal · 나트륨 {item.nutrient.sodium ?? '-'}mg · 단백질 {item.nutrient.protein ?? '-'}g</p>}
      {groups.sauces.length > 0 && <fieldset><legend>소스 1개 선택</legend>{groups.sauces.map((option) => <label key={option.optionId}>
        <input type="radio" name={`sauce-${item.menuId}`} checked={selected.includes(option.optionId)} onChange={() => selectOption(item, option.optionId, true)} />{option.nameKo}
      </label>)}</fieldset>}
      {[...groups.add, ...groups.remove].map((option) => <label key={option.optionId} className="option-row">
        <input type="checkbox" checked={selected.includes(option.optionId)} onChange={(event) => selectOption(item, option.optionId, event.target.checked)} />
        {option.nameKo}{option.extraPrice > 0 ? ` (+${formatPrice(option.extraPrice)})` : ''}
      </label>)}
    </details>;
  };

  const renderLogin = (screen) => <div className="login-panel">
    {session ? <>
      <p>{session.role === 'ADMIN' ? '관리자' : '직원'}로 로그인되어 있습니다.</p>
      <button type="button" disabled={authBusy || adminAction !== null || kdsUpdating !== null} onClick={logout}>로그아웃</button>
      {screen === 'admin' && session.role !== 'ADMIN' && <p className="error">관리자 권한이 필요합니다.</p>}
    </> : <form onSubmit={login} className="login-form">
      <p>{screen === 'admin' ? '관리자' : '주방 직원'} 로그인이 필요합니다.</p>
      <label>아이디 <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>비밀번호 <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <button type="submit" className="primary" disabled={authBusy}>{authBusy ? '처리 중...' : '로그인'}</button>
    </form>}
    {authError && <p role="alert" className="error">{authError}</p>}
  </div>;

  const renderReceipt = () => receipt && <section className="receipt">
    <h2>{isPaidOrder(receipt) ? '결제가 완료되었습니다.' : '주문 내역'}</h2>
    <p>주문번호 {receipt.orderNumber} · 주문 ID {receipt.orderId} · {orderStatusLabel(receipt.status)}</p>
    {(receipt.items || []).map((item, index) => <p key={item.lineId || `${item.menuId}-${index}`}>
      {item.menuNameKo} {item.quantity}개 · {formatPrice(item.subtotal ?? item.unitPrice * item.quantity)}
      {(item.options || []).length > 0 && <small> ({item.options.map((option) => option.nameKo).join(', ')})</small>}
    </p>)}
    <strong>총액 {formatPrice(receipt.totalPrice)}</strong>
  </section>;

  const renderReceiptLookup = () => <details className="receipt-lookup">
    <summary>주문 내역 조회</summary>
    <form onSubmit={lookupReceipt} className="action-row">
      <label>주문 ID <input type="number" min="1" step="1" value={receiptOrderId} onChange={(event) => setReceiptOrderId(event.target.value)} required /></label>
      <button type="submit" disabled={receiptBusy}>조회</button>
    </form>
    {receiptError && <p className="error" role="alert">{receiptError}</p>}
    {renderReceipt()}
  </details>;

  const renderAdminServer = () => <>
    <div className="action-row">
      <label>시작일 <input type="date" value={statsFrom} onChange={(event) => setStatsFrom(event.target.value)} /></label>
      <label>종료일 <input type="date" value={statsTo} onChange={(event) => setStatsTo(event.target.value)} /></label>
      <button disabled={adminBusy || !!adminAction} onClick={loadAdmin}>새로고침</button>
    </div>
    {adminError && <p role="alert" className="error">{adminError}</p>}
    {adminBusy && <p role="status">관리 정보를 불러오는 중입니다.</p>}
    {adminData.sales && <p>총 매출 {formatPrice(adminData.sales.totalSales)} · 주문 {adminData.sales.totalOrders ?? 0}건 · 평균 {formatPrice(adminData.sales.averageOrder)}</p>}
    <details><summary>인기 메뉴</summary>{adminData.popular.map((row, index) => Array.isArray(row) && <p key={`${row[0]}-${index}`}>{row[0]} · {row[1]}개</p>)}</details>
    <details><summary>메뉴 판매 상태</summary>{adminMenuItems.map((item) => <label key={item.menuId} className="toggle-row">
      {item.name}<select value={item.status} disabled={adminAction !== null} onChange={(event) => changeMenuStatus(item.menuId, event.target.value)}>
        <option value="ACTIVE">정상 판매</option><option value="SOLD_OUT">품절</option><option value="INACTIVE">비활성</option>
      </select>
    </label>)}</details>
    <details><summary>주문 목록</summary>{adminData.orders.map((order) => <article className="audit-card" key={order.orderId}>
      <p>{order.orderNumber} · {orderStatusLabel(order.status)} · {formatPrice(order.totalPrice)}</p>
      <button disabled={adminAction !== null} onClick={() => showAdminOrder(order.orderId)}>상세 조회</button>
    </article>)}</details>
    <details><summary>결제 목록</summary>{adminData.payments.map((payment) => <article className="audit-card" key={payment.paymentId}>
      <p>주문 {payment.orderId} · {formatPrice(payment.amount)} · {payment.method}</p>
      <button disabled={adminAction !== null || payment.pgProvider !== 'TEST'} onClick={() => refundPayment(payment)}>결제 취소</button>
    </article>)}</details>
    {renderReceipt()}
  </>;

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
            disabled={checkoutBusy}
            className={currentScreen === screen ? 'active' : ''}
            onClick={() => { if (!paymentBusyRef.current) setCurrentScreen(screen); }}
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
        {hasAuthenticatedPayment && <p className="hint" role="status">메뉴는 담을 수 있습니다. 새 주문 결제 전에는 장바구니에서 이전 결제 결과를 확인해 주세요.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {menuLoading && <p role="status">메뉴를 불러오는 중입니다.</p>}
        {menuError && <p className="error" role="alert">{menuError}</p>}
        {menuSource !== 'server' && !menuLoading && <p className="hint">예시 메뉴입니다. 서버 메뉴를 불러온 뒤 주문할 수 있습니다.</p>}
        <button type="button" disabled={menuLoading || checkoutBusy} onClick={loadMenus}>메뉴 다시 불러오기</button>
        {needSnapshotTouch && <p className="hint">화면을 한 번 터치하면 오류 확인용 스냅샷을 전송합니다.</p>}
        <div className="action-row">
          <button className="primary" onClick={isRecording ? stopVoiceStreaming : startVoiceStreaming}>
            {isRecording ? '음성 중지' : '음성 시작'}
          </button>
          <button onClick={captureSnapshot}>스냅샷 캡처</button>
          <button disabled={checkoutBusy} onClick={simulateAgeEstimate}>연령 추정</button>
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
            <article key={item.id} className={`item-card ${item.status === 'SOLD_OUT' ? 'sold-out' : ''}`}>
              <div className="item-image">{renderMenuImage(item)}</div>
              <h3>{item.name}</h3>
              <p>{formatPrice(item.price)}{item.status === 'SOLD_OUT' && ' · 품절'}</p>
              {renderMenuOptions(item)}
              <button className="primary" disabled={menuSource !== 'server' || item.status !== 'ACTIVE' || checkoutBusy} onClick={() => addToCart(item)}>담기</button>
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
      {hasAuthenticatedPayment && <p role="status">메뉴는 담거나 수정할 수 있습니다. 새 주문 결제 전에는 아래 버튼으로 이전 결제 결과를 먼저 확인해 주세요.</p>}
      {!cart.length ? (
        <p className="empty">장바구니가 비어 있습니다. 메뉴 화면에서 상품을 담아 주세요.</p>
      ) : (
        <div className="cart-list">
          {cart.map((item) => (
            <article key={item.lineId} className="cart-item">
              <div>
                <h3>{item.name}</h3>
                {item.optionNames?.length > 0 && <small>{item.optionNames.join(', ')}</small>}
                <p>{formatPrice(item.price)} / 합계 {formatPrice(item.price * item.quantity)}</p>
              </div>
              <div className="quantity-controls">
                <button disabled={checkoutBusy} onClick={() => updateQuantity(item.lineId, item.quantity - 1)}>-</button>
                <span>{item.quantity}</span>
                <button disabled={checkoutBusy} onClick={() => updateQuantity(item.lineId, item.quantity + 1)}>+</button>
                <button disabled={checkoutBusy} onClick={() => removeFromCart(item.lineId)}>삭제</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {renderReceiptLookup()}
      <div className="action-row">
        <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
        <button onClick={() => setCurrentScreen('recommendations')}>추천 확인</button>
        <button className="primary" disabled={!cart.length && !hasAuthenticatedPayment} onClick={() => setCurrentScreen('payment')}>
          {hasAuthenticatedPayment ? '결제 결과 확인' : '결제하기'}
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
            <div className="item-image">{renderMenuImage(item)}</div>
            <h3>{item.name}</h3>
            <p>{formatPrice(item.price)}</p>
            <small>신뢰도 {Math.round((item.confidence || 0.64) * 100)}%</small>
            <button className="primary" disabled={menuSource !== 'server' || item.status !== 'ACTIVE' || checkoutBusy} onClick={() => addToCart(item)}>장바구니 담기</button>
          </article>
        ))}
      </div>
    </main>
  );

  const renderPayment = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>결제</h2>
        <strong>{formatPrice(paymentInfo?.totalPrice ?? totalPrice)}</strong>
      </div>
      <p role="status" aria-live="polite">{paymentStatus}</p>
      {hasAuthenticatedPayment && typeof paymentInfo?.orderNumber === 'string' && <p className="hint">
        이전 주문 {paymentInfo.orderNumber}의 결과를 확인합니다. 추가한 메뉴는 장바구니에 별도로 유지됩니다.
      </p>}
      {paymentError && <>
        <p className="error" role="alert">{typeof paymentError === 'string' ? paymentError : paymentError.message}</p>
        {typeof paymentInfo?.orderNumber === 'string' && Number.isSafeInteger(paymentInfo.orderId) && <p className="hint">
          주문번호 {paymentInfo.orderNumber} · 주문 ID {paymentInfo.orderId}
        </p>}
        {(paymentError.requestPath || paymentError.status) && <details className="menu-details">
          <summary>오류 정보</summary>
          <p>{paymentError.stage}{paymentError.status ? ` · HTTP ${paymentError.status}` : ''}</p>
          {paymentError.requestPath && <code>{paymentError.requestMethod} {paymentError.requestPath}</code>}
        </details>}
      </>}
      <div className="payment-shell">
        {isPaymentWidgetLoading && (
          <div className="payment-placeholder">
            결제 위젯을 불러오는 중입니다. 잠시만 기다려 주세요.
          </div>
        )}
        {!isPaymentWidgetLoading && !isPaymentWidgetReady && (
          <div className="payment-placeholder">
            {paymentError ? '결제 준비 상태를 확인해 주세요.' : '결제 수단을 자동으로 불러옵니다.'}
          </div>
        )}
        <div id="payment-widget" className="payment-widget" />
        <div id="agreement-widget" className="payment-widget agreement-widget" />
      </div>
      <div className="action-row">
        <button disabled={checkoutBusy} onClick={() => setCurrentScreen('cart')}>장바구니로 돌아가기</button>
        <button className="primary" disabled={(!cart.length && !hasAuthenticatedPayment) || isPaymentWidgetLoading || checkoutBusy} onClick={requestTossPayment}>
          {checkoutBusy ? '결제 처리 중...' : hasAuthenticatedPayment
            ? savedCheckout?.phase === 'confirming' ? '결제 상태 확인' : '결제 계속하기'
            : savedCheckout?.phase === 'closed' ? '새 주문으로 결제' : '결제하기'}
        </button>
      </div>
    </main>
  );

  const renderAgeResult = () => (
    <main className="screen age-result">
      <h2>연령 추정 결과</h2>
      <p className="age-number">{ageEstimate}세</p>
      <p>추정 결과에 따라 고대비 UI와 추천 화면으로 빠르게 이동할 수 있습니다.</p>
      <p className="hint">AI 분석 연결 전의 예시 결과입니다.</p>
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
        <button className="primary" disabled={!cart.length || checkoutBusy} onClick={submitOrderToKds}>현재 장바구니 접수</button>
      </div>
      {renderReceipt()}
      {paymentError && <p className="error" role="alert">{typeof paymentError === 'string' ? paymentError : paymentError.message}</p>}
      {renderLogin('kds')}
      {session && <>
        <div className="action-row"><button disabled={kdsLoading || kdsUpdating !== null} onClick={() => loadKdsOrders()}>주문 새로고침</button><span>실시간 주문: {statusLabel[kdsStreamStatus] || kdsStreamStatus}</span></div>
        {kdsError && <p className="error" role="alert">{kdsError}</p>}
        {kdsLoading && <p role="status">주문을 불러오는 중입니다.</p>}
        {!kdsLoading && !kdsOrders.length && <p className="empty">대기 주문이 없습니다.</p>}
        <div className="kds-list">
          {kdsOrders.map((order) => <article key={order.id} className="kds-card">
            <div><h3>{order.number}</h3><p>{order.menu}</p><small>{order.createdAt} / 수량 {order.qty}</small></div>
            <select aria-label={`${order.number} 조리 상태`} value={order.status} disabled={kdsUpdating !== null} onChange={(event) => updateKdsStatus(order.id, event.target.value)}>
              <option value="PAID" disabled>조리 대기</option><option value="PREPARING">조리 중</option><option value="COMPLETED">완료 대기</option>
            </select>
          </article>)}
        </div>
      </>}
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
          <button onClick={() => { retryCountRef.current = 0; setRetryCount(0); connectWebSocket(); }}>WebSocket 재연결</button>
          <button onClick={() => addAuditLog('관리자 점검', '수동 점검 로그 추가', 'admin')}>감사 로그 추가</button>
        </div>
      </section>
      <section>
        <h2>보안 감사 로그</h2>
        <p>이 기기에서 발생한 작업 기록입니다.</p>
        {!adminLogs.length && <p>아직 기록이 없습니다.</p>}
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
      <section className="server-admin">
        <h2>서버 관리</h2>
        {renderLogin('admin')}
        {session?.role === 'ADMIN' && renderAdminServer()}
      </section>
    </main>
  );

  aiMessageHandlerRef.current = handleAiMessage;
  speakRef.current = speak;

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
