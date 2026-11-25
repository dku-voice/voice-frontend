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
import MenuImage from './components/MenuImage.jsx';
import { availableRecommendations } from './domain/menu-display.js';
import { readLanguage, storeLanguage, supportedLanguage, translate, localeFor, formatMoney, orderSummary } from './i18n/index.js';
import { localizeTree } from './i18n/react.js';
import LanguageSelector from './i18n/LanguageSelector.jsx';
import { createVoiceWait, receiveVoiceMessage, createVoiceLanguageGuard, waitForVoiceSocket } from './integration/voice-language.js';
import { isVoiceOrderResponse, normalizeVoiceOrderResponse } from './integration/voice-order.js';
import { ageAnalysisApi } from './api/vision.js';
import { createAgeCamera } from './integration/age-camera.js';
import { createAutoAgeMonitor } from './integration/auto-age-monitor.js';
import { rankTtsVoices, selectTtsVoice, ttsSettings, waitForTtsVoice } from './integration/tts.js';

const AI_WS_URL = runtimeConfig.aiWsUrl;
const LOCAL_MOCK_PAYMENT = import.meta.env.MODE === 'local-mock'
  && ['127.0.0.1', 'localhost'].includes(globalThis.window?.location?.hostname);

const statusLabel = {
  connecting: '연결 중',
  open: '연결됨',
  closed: '연결 끊김',
  error: '오류',
};

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

const COMPLETE_RETURN_SECONDS = 30;
const TTS_ECHO_GRACE_MS = 450;
const PROMPT_MUTE_LIMIT_MS = 6000;
const START_CAMERA_OPEN_MS = 5000;
const START_CAMERA_ANALYZE_MS = 8000;
const initialKioskStage = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 'ordering';
  return window.location?.pathname?.startsWith('/payment/') ? 'ordering' : 'welcome';
};
const resolveWithin = (promise, ms) => Promise.race([
  Promise.resolve(promise).catch(() => null),
  new Promise((resolve) => { setTimeout(() => resolve(null), ms); }),
]);

function App() {
  const [language, setLanguage] = useState(readLanguage);
  const languageRef = useRef(language);
  languageRef.current = language;
  const formatPrice = (value) => formatMoney(value, language);
  const checkoutRef = useRef(null);
  if (!checkoutRef.current) checkoutRef.current = createCheckoutManager({ api: kioskApi, storage: browserSessionStorage });
  const [menuCatalog, setMenuCatalog] = useState([]);
  const [adminMenuItems, setAdminMenuItems] = useState([]);
  const [menuSource, setMenuSource] = useState('loading');
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState('');
  const [optionSelections, setOptionSelections] = useState({});
  const [currentScreen, setCurrentScreen] = useState('menu');
  const currentScreenRef = useRef(currentScreen);
  currentScreenRef.current = currentScreen;
  const [selectedCategory, setSelectedCategory] = useState('');
  const [cart, setCart] = useState(() => checkoutRef.current.getSaved()?.phase === 'paid' ? [] : checkoutRef.current.restoreCart());
  const [recommendations, setRecommendations] = useState([]);
  const [voiceRecommendation, setVoiceRecommendation] = useState(null);
  const [kdsOrders, setKdsOrders] = useState([]);
  const [adminLogs, setAdminLogs] = useState([]);
  const [wsStatus, setWsStatus] = useState('closed');
  const [retryCount, setRetryCount] = useState(0);
  const [message, setMessage] = useState('환영합니다. 음성 또는 화면 터치로 주문을 시작하세요.');
  const [kioskStage, setKioskStage] = useState(initialKioskStage);
  const kioskStageRef = useRef(kioskStage);
  kioskStageRef.current = kioskStage;
  const [startPhase, setStartPhase] = useState('idle');
  const startingOrderRef = useRef(false);
  const [completeCountdown, setCompleteCountdown] = useState(0);
  const [error, setError] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [voiceFinalizing, setVoiceFinalizing] = useState(false);
  const [noiseEngine, setNoiseEngine] = useState('대기 중');
  const [cameraState, setCameraState] = useState({ phase: 'idle', error: null, result: null });
  const [ageSource, setAgeSource] = useState('voice');
  const [aiResponsePending, setAiResponsePending] = useState(false);
  const [responseDelayTriggered, setResponseDelayTriggered] = useState(false);
  const [needSnapshotTouch, setNeedSnapshotTouch] = useState(false);
  const [ageEstimate, setAgeEstimate] = useState(null);
  const [highContrast, setHighContrast] = useState(false);
  const [seniorDemo, setSeniorDemo] = useState(false);
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
  const cameraModeRef = useRef('idle');
  const autoAgeMonitorRef = useRef(null);
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
  const voiceWaitRef = useRef(null);
  const voiceWaitSocketRef = useRef(null);
  const voiceWaitLanguageRef = useRef(null);
  const voiceStartAbortRef = useRef(null);
  const voiceSessionRef = useRef(false);
  const voiceEndSentRef = useRef(false);
  const voiceLanguageGuardRef = useRef(null);
  if (!voiceLanguageGuardRef.current) voiceLanguageGuardRef.current = createVoiceLanguageGuard();
  const ttsActiveRef = useRef(false);
  const ttsGraceTimerRef = useRef(null);
  const promptMuteTimerRef = useRef(null);
  const ttsUtteranceRef = useRef(null);
  const ttsVoicesRef = useRef([]);
  const ttsRequestRef = useRef(0);
  const appMountedRef = useRef(false);
  const retryCountRef = useRef(0);
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
  const cameraRef = useRef(null);
  const cameraContextActive = () => {
    const mode = cameraModeRef.current;
    const screenReady = mode === 'start'
      ? currentScreenRef.current === 'menu' && kioskStageRef.current === 'welcome'
      : currentScreenRef.current === (mode === 'auto' ? 'menu' : 'ageResult');
    return appMountedRef.current && screenReady
      && !voiceStartingRef.current && !voiceSessionRef.current && !voiceWaitRef.current?.active && !paymentBusyRef.current;
  };
  if (!cameraRef.current) cameraRef.current = createAgeCamera({
    getVideo: () => videoRef.current,
    analyze: (blob, options) => {
      if (!cameraContextActive()) throw Object.assign(new Error('나이 분석 요청이 취소되었습니다.'), { name: 'AbortError' });
      return ageAnalysisApi.analyze(blob, options);
    },
    onState: (next) => {
      if (!cameraContextActive()) return;
      const automatic = cameraModeRef.current === 'auto';
      const waitingForPerson = automatic && next.phase === 'preview' && next.error?.code === 'ANALYSIS_FAILED';
      setCameraState(waitingForPerson ? { ...next, error: null } : next);
      if ((!automatic && next.phase !== 'success') || next.phase === 'error' || waitingForPerson) {
        setAgeEstimate(null);
        setAgeSource('camera');
      }
      const labels = { idle: '대기 중', opening: '카메라 준비 중', preview: '카메라 켜짐', capturing: '사진 준비 중',
        analyzing: '나이 분석 중', success: '분석 완료', error: '분석 실패' };
      setSnapshotStatus(waitingForPerson ? '대기 중' : labels[next.phase] || '대기 중');
    },
    onResult: (result) => {
      if (!cameraContextActive()) return;
      // No team policy is confirmed: isSenior/ageGroup must not select a mode.
      setAgeSource('camera');
      setAgeEstimate(result.estimatedAge);
      setSnapshotStatus('분석 완료');
      if (cameraModeRef.current === 'manual') speakRef.current?.('나이 분석이 완료되었습니다.');
    },
    retainPreviewAfterAnalyze: () => cameraModeRef.current === 'auto',
  });
  if (!autoAgeMonitorRef.current) autoAgeMonitorRef.current = createAutoAgeMonitor({
    openCamera: () => cameraRef.current.open(),
    analyzeCamera: () => cameraRef.current.analyze(),
    cancelCamera: () => {
      cameraRef.current.cancel();
      if (cameraModeRef.current === 'auto') cameraModeRef.current = 'idle';
      if (appMountedRef.current) {
        setCameraState({ phase: 'idle', error: null, result: null });
        setSnapshotStatus('대기 중');
      }
    },
    getCameraState: () => cameraRef.current.getState(),
    canRun: () => cameraModeRef.current === 'auto' && cameraContextActive()
      && globalThis.document?.visibilityState !== 'hidden',
  });
  const cameraProcessing = cameraModeRef.current !== 'auto'
    && ['opening', 'capturing', 'analyzing'].includes(cameraState.phase);

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

  const visibleRecommendations = useMemo(
    () => menuSource === 'server' ? availableRecommendations(recommendations, allMenuItems, cart) : [],
    [recommendations, allMenuItems, cart, menuSource],
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
    const refreshTtsVoices = () => {
      const voices = window.speechSynthesis?.getVoices?.();
      ttsVoicesRef.current = Array.isArray(voices) ? voices : [];
    };
    refreshTtsVoices();
    window.speechSynthesis?.addEventListener?.('voiceschanged', refreshTtsVoices);
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
        if (!voiceSessionRef.current || data.generation !== voiceGenerationRef.current) return;
        setNoiseEngine(data.engine === 'wasm' ? 'WASM 모듈' : 'JS 폴백');
        sendAudioToServer(data.pcm);
      }
    };

    connectWebSocket();

    return () => {
      appMountedRef.current = false;
      menuRequestRef.current?.abort();
      cameraRef.current?.cancel();
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
      voiceWaitRef.current?.finish();
      ttsRequestRef.current += 1;
      window.speechSynthesis?.cancel();
      window.speechSynthesis?.removeEventListener?.('voiceschanged', refreshTtsVoices);
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
      { id: Date.now(), time, createdAt: now.toISOString(), event, user, detail },
      ...prev,
    ]);
  };

  // 에코 루프 방지: TTS 안내 멘트 재생 구간에는 마이크 캡처를 멈춰
  // 키오스크 스피커 출력이 마이크로 재유입되는 것을 차단하고, 재생 후 재개한다.
  //  - 캡처 트랙을 비활성화해 AudioWorklet 이 무음만 받도록 하고
  //  - 캡처 프레임 전달 게이트(ttsActiveRef)로 한 번 더 차단한다.
  const pauseMicForTts = () => {
    clearTimeout(ttsGraceTimerRef.current);
    ttsActiveRef.current = true;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
  };

  const muteUntilPromptEnds = () => {
    pauseMicForTts();
    clearTimeout(promptMuteTimerRef.current);
    promptMuteTimerRef.current = setTimeout(() => {
      if (ttsActiveRef.current) resumeMicAfterTts();
    }, PROMPT_MUTE_LIMIT_MS);
  };

  const resumeMicAfterTts = () => {
    clearTimeout(promptMuteTimerRef.current);
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    if (!ttsActiveRef.current) return;
    clearTimeout(ttsGraceTimerRef.current);
    ttsGraceTimerRef.current = setTimeout(() => {
      ttsActiveRef.current = false;
    }, TTS_ECHO_GRACE_MS);
  };

  const speak = (text) => {
    setMessage(text);
    const requestId = ++ttsRequestRef.current;
    if (!ttsEnabledRef.current || !('speechSynthesis' in window)) {
      // TTS 미사용 시에도 직전 재생으로 멈춰 둔 마이크는 복구한다.
      resumeMicAfterTts();
      return;
    }

    const synthesis = window.speechSynthesis;
    ttsUtteranceRef.current = null;
    synthesis.cancel();
    const language = languageRef.current;
    const locale = localeFor(language);
    const speech = ttsSettings(language);
    const spokenText = translate(text, language);

    const prepare = async () => {
      let availableVoices = ttsVoicesRef.current.length
        ? ttsVoicesRef.current : synthesis.getVoices?.() || [];
      let selectedVoice = selectTtsVoice(availableVoices, language, locale);
      if (!selectedVoice && language !== 'ko') {
        selectedVoice = await waitForTtsVoice(synthesis, language, locale);
        availableVoices = synthesis.getVoices?.() || availableVoices;
        ttsVoicesRef.current = availableVoices;
      }
      if (requestId !== ttsRequestRef.current || !ttsEnabledRef.current) return;

      const candidates = rankTtsVoices(availableVoices, language, locale) || [];
      let candidateIndex = Math.max(0, candidates.indexOf(selectedVoice));
      let defaultTried = false;
      const play = (voice) => {
        if (requestId !== ttsRequestRef.current) return;
        const utterance = new SpeechSynthesisUtterance(spokenText);
        utterance.lang = locale;
        if (voice) utterance.voice = voice;
        utterance.rate = speech.rate;
        utterance.pitch = speech.pitch;
        utterance.onstart = () => pauseMicForTts();
        utterance.onend = () => {
          if (ttsUtteranceRef.current !== utterance) return;
          ttsUtteranceRef.current = null;
          resumeMicAfterTts();
        };
        utterance.onerror = (event) => {
          if (ttsUtteranceRef.current !== utterance || requestId !== ttsRequestRef.current) return;
          const retryable = ['voice-unavailable', 'language-unavailable', 'synthesis-unavailable'].includes(event?.error);
          if (retryable && voice && candidates[candidateIndex + 1]) {
            candidateIndex += 1;
            play(candidates[candidateIndex]);
            return;
          }
          if (retryable && voice && !defaultTried) {
            defaultTried = true;
            play(null);
            return;
          }
          ttsUtteranceRef.current = null;
          resumeMicAfterTts();
        };
        ttsUtteranceRef.current = utterance;
        synthesis.speak(utterance);
      };
      play(selectedVoice);
    };
    void prepare();
  };

  const connectWebSocket = () => {
    if (!AI_WS_URL || !appMountedRef.current) return null;
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(wsRef.current?.readyState)) return wsRef.current;
    clearTimeout(reconnectTimerRef.current);
    setWsStatus('connecting');
    const websocket = new WebSocket(AI_WS_URL);
    wsRef.current = websocket;
    let receiving = true;
    const ownsSocket = () => appMountedRef.current && wsRef.current === websocket;
    const current = () => ownsSocket() && receiving;
    websocket.onopen = () => {
      if (!current()) return;
      retryCountRef.current = 0;
      setWsStatus('open');
      setRetryCount(0);
      speakRef.current?.('음성 주문을 시작할 수 있습니다.');
      addAuditLog('WebSocket 연결', '음성 서버 연결');
    };
    websocket.onmessage = (event) => {
      if (!current()) return;
      aiMessageHandlerRef.current?.(event.data, websocket);
    };
    websocket.onerror = () => {
      if (!current()) return;
      receiving = false;
      stopVoiceStreaming(false);
      setWsStatus('error');
      setError('AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.');
      websocket.close();
    };
    websocket.onclose = () => {
      if (!ownsSocket()) return;
      receiving = false;
      stopVoiceStreaming(false);
      setWsStatus('closed');
      setError('AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.');
      if (retryCountRef.current >= 5) return;
      retryCountRef.current += 1;
      setRetryCount(retryCountRef.current);
      reconnectTimerRef.current = window.setTimeout(connectWebSocket, retryCountRef.current * 2000);
    };
    return websocket;
  };

  const retireVoiceSocket = (socket) => {
    if (!socket || wsRef.current !== socket) return;
    wsRef.current = null;
    clearTimeout(reconnectTimerRef.current);
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
    socket.close();
    setWsStatus('closed');
  };

  const handleAiMessage = (rawMessage, websocket) => {
    let data;
    try {
      data = receiveVoiceMessage(rawMessage, {
        voiceActive: voiceSessionRef.current, currentLanguage: languageRef.current, onLanguage: changeLanguage,
        onLanguageDetected: (next) => voiceWaitRef.current.changeLanguage(next),
        canApplyLanguage: () => voiceLanguageGuardRef.current.acceptResponse(websocket),
      });
    } catch {
      stopVoiceStreaming(false);
      retireVoiceSocket(websocket);
      setError('AI 서버 응답 형식이 올바르지 않습니다.');
      addAuditLog('AI 응답 파싱 실패', String(rawMessage).slice(0, 80));
      return;
    }

    if (data.type === 'recommendation' && typeof data.recognized_text === 'string') {
      clearResponseDelay();
      stopVoiceStreaming(false);
      const picks = (Array.isArray(data.items) ? data.items : []).map((item) => {
        const menu = resolveMenu({ menuId: Number(item?.menu_id), name: item?.name });
        if (!menu) return null;
        return { menu, reason: typeof item?.reason === 'string' ? item.reason.trim() : '' };
      }).filter(Boolean);
      if (data.recognized_text) setMessage(`인식 내용: ${data.recognized_text}`);
      addAuditLog('음성 추천', `${picks.length}건 (${data.source === 'llm' ? 'AI' : '규칙'})`);
      if (!picks.length) {
        setError('추천할 메뉴를 찾지 못했습니다. 다시 말씀하거나 화면 터치로 주문해 주세요.');
        return;
      }
      setVoiceRecommendation({ query: data.recognized_text, items: picks });
      if (currentScreenRef.current !== 'payment') setCurrentScreen('recommendations');
      speakRef.current?.('추천 메뉴를 보여 드릴게요.');
      return;
    }

    if (isVoiceOrderResponse(data)) {
      try {
        const result = normalizeVoiceOrderResponse(data, menuItemsRef.current);
        clearResponseDelay();
        stopVoiceStreaming(false);
        if (result.failed) {
          setError('음성 주문을 처리하지 못했습니다. 다시 말씀하거나 화면 터치로 주문해 주세요.');
          return;
        }
        if (result.recognizedText) setMessage(`인식 내용: ${result.recognizedText}`);
        if (!result.items.length) {
          setError('인식된 메뉴가 없습니다. 다시 말씀하거나 화면 터치로 주문해 주세요.');
          return;
        }
        if (currentScreenRef.current === 'payment') return;
        addVoiceOrderToCart(result.items);
      } catch (failure) {
        stopVoiceStreaming(false);
        setError(failure.message || 'AI 서버 응답 형식이 올바르지 않습니다.');
      }
      return;
    }

    // Language metadata is not proof that analysis or a legacy order has completed.
    if (data.type === 'order' && (!data.item || typeof data.item !== 'object' || Array.isArray(data.item))) {
      stopVoiceStreaming(false);
      retireVoiceSocket(websocket);
      setError('AI 서버 응답 형식이 올바르지 않습니다.');
      return;
    }
    if (['order', 'recommendation'].includes(data.type)) clearResponseDelay();

    if (data.type === 'order' && data.item && currentScreen !== 'payment') {
      addToCart(data.item);
    }

    if (data.type === 'age_estimate' && Number.isFinite(data.age) && data.age >= 0 && data.age <= 120) {
      // Legacy WS estimates may be shown only on the already-open age screen.
      // They never navigate or replace an explicit camera analysis result.
      if (currentScreenRef.current === 'ageResult' && !cameraRef.current.busy && ageSource !== 'camera') {
        clearResponseDelay();
        setAgeEstimate(data.age);
      }
    }

    if (data.type === 'recommendation') {
      const items = Array.isArray(data.items) ? data.items.map((item) => {
        const known = resolveMenu(item);
        return known || null;
      }).filter(Boolean) : [];
      setRecommendations(items);
    }

    if (data.type === 'kds_status' && data.order) {
      // Kitchen order authority belongs to the authenticated backend SSE stream.
      addAuditLog('AI 상태 수신', '주방 주문 상태는 주문 서버에서 확인합니다.');
    }
  };

  // Local PCM activity estimates the end of speech; it is not a server analysis event.
  if (!voiceWaitRef.current) voiceWaitRef.current = createVoiceWait({
    onRecording: () => {
      setAiResponsePending(false);
      setResponseDelayTriggered(false);
      setNeedSnapshotTouch(false);
      setMessage('원하는 메뉴를 말씀해 주세요.');
    },
    onWaiting: () => {
      setMessage('음성 결과를 계속 기다리고 있습니다. 화면 터치로도 주문할 수 있습니다.');
    },
    onUtteranceEnd: () => sendVoiceEnd(),
    onPending: () => {
      setAiResponsePending(true);
      addAuditLog('AI 응답 지연', '3초 초과, 로딩 피드백 표시');
    },
    onTouch: ({ deadline }) => {
      setResponseDelayTriggered(true);
      setAiResponsePending(false);
      // Touch is offered without interrupting recognition or opening a camera.
      setNeedSnapshotTouch(false);
      // Do not start TTS here: it would pause the mic during a long foreign utterance.
      setMessage('음성 결과를 계속 기다리고 있습니다. 화면 터치로도 주문할 수 있습니다.');
      addAuditLog('AI 응답 지연', `${deadline / 1000}초 초과, 터치 주문 안내`);
    },
    onTimeout: () => {
      const socket = voiceWaitSocketRef.current;
      stopVoiceStreaming(false);
      retireVoiceSocket(socket);
      setResponseDelayTriggered(true);
      setNeedSnapshotTouch(Boolean(runtimeConfig.aiSnapshotUrl));
      const message = '음성 응답 대기 시간이 초과되었습니다. 화면 터치로 주문하거나 음성 시작을 눌러 다시 시도해 주세요.';
      setMessage(message);
      setError(message);
    },
  });
  const startResponseDelayTimer = (pcm) => {
    voiceWaitSocketRef.current = wsRef.current;
    voiceWaitRef.current.audio(pcm, voiceWaitLanguageRef.current);
  };
  const clearResponseDelay = () => {
    voiceWaitRef.current.finish();
    voiceWaitSocketRef.current = null;
    setAiResponsePending(false);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };
  const changeLanguage = (next) => {
    if (!supportedLanguage(next) || next === languageRef.current) return;
    voiceWaitLanguageRef.current = null;
    languageRef.current = next;
    setLanguage(next);
    storeLanguage(next);
    voiceWaitRef.current.changeLanguage(null);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
    window.speechSynthesis?.cancel();
    ttsUtteranceRef.current = null;
    resumeMicAfterTts();
  };
  const selectLanguageManually = (next) => {
    if (!supportedLanguage(next)) return;
    // Even selecting the current language overrides an older voice request.
    voiceLanguageGuardRef.current.manualSelection();
    changeLanguage(next);
    voiceWaitLanguageRef.current = next;
    voiceWaitRef.current.changeLanguage(next);
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const startVoiceStreaming = async () => {
    if (streamRef.current || voiceStartingRef.current || paymentBusyRef.current) return;
    cancelCamera();
    voiceStartingRef.current = true;
    voiceEndSentRef.current = false;
    setVoiceFinalizing(false);
    clearResponseDelay();
    if (wsRef.current && voiceLanguageGuardRef.current.hasPending(wsRef.current)) retireVoiceSocket(wsRef.current);
    const startController = new AbortController();
    voiceStartAbortRef.current = startController;
    const generation = ++voiceGenerationRef.current;
    voiceLanguageGuardRef.current.startSession();
    const current = () => appMountedRef.current && voiceGenerationRef.current === generation;
    let microphoneRequested = false;
    try {
      const socket = connectWebSocket();
      if (!socket) throw new Error('AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.');
      await waitForVoiceSocket(socket, { signal: startController.signal });
      if (!current()) return;
      microphoneRequested = true;
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
        if (ttsActiveRef.current || !current()) return;
        const frame = event.data;
        workerRef.current?.postMessage({ type: 'reduce-noise', pcm: frame, generation }, [frame.buffer]);
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination); // 무음 출력, 그래프 활성 유지

      voiceSessionRef.current = true;
      setIsRecording(true);
      setError('');
      muteUntilPromptEnds();
      speak('원하는 메뉴를 말씀해 주세요.');
    } catch (failure) {
      if (!current()) return;
      stopVoiceStreaming(false);
      if (!microphoneRequested) retireVoiceSocket(wsRef.current);
      setError(failure.message || '마이크 권한이 필요합니다. 브라우저 권한을 허용한 뒤 다시 시도하세요.');
      speak(microphoneRequested ? '마이크 권한 또는 오디오 설정을 확인해 주세요.' : 'AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.');
    } finally {
      if (voiceGenerationRef.current === generation) {
        voiceStartingRef.current = false;
        voiceStartAbortRef.current = null;
      }
    }
  };

  const stopVoiceStreaming = (announce = true) => {
    voiceStartAbortRef.current?.abort();
    voiceStartAbortRef.current = null;
    voiceSessionRef.current = false;
    voiceEndSentRef.current = false;
    voiceLanguageGuardRef.current.stopSession();
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
    setVoiceFinalizing(false);
    if (announce) {
      retireVoiceSocket(wsRef.current);
      speak('음성 인식을 종료했습니다.');
    }
  };

  const sendVoiceEnd = () => {
    const socket = wsRef.current;
    if (!voiceSessionRef.current || voiceEndSentRef.current || socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(`END:${languageRef.current}`);
      voiceEndSentRef.current = true;
      setVoiceFinalizing(true);
      setMessage('음성 분석 결과를 기다리고 있습니다.');
      return true;
    } catch {
      stopVoiceStreaming(false);
      retireVoiceSocket(socket);
      setError('AI 서버에 녹음 종료 신호를 전송하지 못했습니다. 다시 시도해 주세요.');
      return false;
    }
  };

  const finishVoiceStreaming = () => {
    if (!sendVoiceEnd()) return;
    setIsRecording(false);
  };

  const sendAudioToServer = async (buffer) => {
    if (!buffer || !voiceSessionRef.current || voiceEndSentRef.current) return;
    const socket = wsRef.current;
    try {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('socket not open');
      socket.send(buffer);
      voiceLanguageGuardRef.current.audioSent(socket);
      startResponseDelayTimer(buffer);
    } catch {
      stopVoiceStreaming(false);
      retireVoiceSocket(socket);
      setError('AI 서버가 연결되지 않아 음성 데이터는 전송하지 못했습니다.');
    }
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
      const optionIds = Array.isArray(candidate.optionIds) ? candidate.optionIds : optionSelections[menu.menuId] || [];
      const item = createCartItem(menu, optionIds, candidate.quantity ?? 1);
      checkoutRef.current.clearPaid();
      setCart((prev) => addCartItem(prev, item));
      setError('');
      speak(`${item.name}을 장바구니에 담았습니다.`);
    } catch (failure) { setError(failure.message); }
  };

  const addVoiceOrderToCart = (candidates) => {
    if (paymentBusyRef.current) return;
    try {
      if (menuSourceRef.current !== 'server') throw new Error('서버 메뉴를 불러온 뒤 주문할 수 있습니다.');
      const items = candidates.map((candidate) => {
        const menu = resolveMenu(candidate);
        if (!menu) throw new Error('주문할 메뉴를 서버 목록에서 확인할 수 없습니다.');
        return createCartItem(menu, candidate.optionIds, candidate.quantity);
      });
      checkoutRef.current.clearPaid();
      setCart((previous) => items.reduce((next, item) => addCartItem(next, item), previous));
      setError('');
      speak(`${items.map((item) => `${item.name} ${item.quantity}개`).join(', ')}를 장바구니에 담았습니다.`);
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

  const buildRecommendations = (cartItems) =>
    availableRecommendations(menuItemsRef.current, menuItemsRef.current, cartItems).slice(0, 3);

  const cancelCamera = () => {
    autoAgeMonitorRef.current?.stop();
    cameraModeRef.current = 'idle';
    cameraRef.current.cancel();
    if (!appMountedRef.current) return;
    setCameraState({ phase: 'idle', error: null, result: null });
    setAgeEstimate(null);
    setAgeSource('voice');
    setSnapshotStatus('대기 중');
  };
  const openAgeAnalysis = () => {
    if (paymentBusyRef.current) {
      setError('결제 처리 중에는 카메라 분석을 시작할 수 없습니다.');
      return;
    }
    if (voiceStartingRef.current || voiceSessionRef.current || voiceWaitRef.current.active) {
      setError('음성 인식을 중지한 뒤 카메라 분석을 시작해 주세요.');
      return;
    }
    cancelCamera();
    cameraModeRef.current = 'manual';
    setCurrentScreen('ageResult');
  };
  const openCamera = () => {
    cameraModeRef.current = 'manual';
    if (cameraContextActive()) cameraRef.current.open();
  };
  const analyzeCamera = () => { if (cameraContextActive()) cameraRef.current.analyze(); };
  const enterOrdering = (mode) => {
    setStartPhase('idle');
    setKioskStage('ordering');
    setCurrentScreen('menu');
    speak(mode === 'touch' ? '메뉴를 눌러 장바구니에 담아 주세요.' : '음성 시작 버튼을 누르고 원하는 메뉴를 말씀해 주세요.');
  };
  const startOrder = async () => {
    if (startingOrderRef.current || kioskStageRef.current !== 'welcome' || paymentBusyRef.current) return;
    startingOrderRef.current = true;
    setStartPhase('analyzing');
    setMessage('잠시 화면을 바라봐 주세요.');
    cameraModeRef.current = 'start';
    let result = null;
    try {
      const opened = await resolveWithin(cameraRef.current.open(), START_CAMERA_OPEN_MS);
      if (opened && cameraContextActive()) result = await resolveWithin(cameraRef.current.analyze(), START_CAMERA_ANALYZE_MS);
    } finally {
      cameraRef.current.cancel();
      cameraModeRef.current = 'idle';
      startingOrderRef.current = false;
    }
    if (!appMountedRef.current || kioskStageRef.current !== 'welcome') return;
    setSnapshotStatus(result ? '분석 완료' : '대기 중');
    setCameraState({ phase: 'idle', error: null, result: null });
    if (result) {
      setAgeSource('camera');
      setAgeEstimate(result.estimatedAge);
      addAuditLog('주문 시작 나이 분석', `${result.estimatedAge}세`);
    }
    if (seniorDemo || result?.isSenior) {
      if (seniorDemo) addAuditLog('시연 모드', '60세 이상 안내 표시');
      setStartPhase('senior');
      speak('화면 터치로 주문하시겠어요?');
      return;
    }
    enterOrdering('voice');
  };
  const returnToWelcome = () => {
    if (paymentBusyRef.current) return;
    if (voiceStartingRef.current || voiceSessionRef.current || voiceWaitRef.current.active) {
      stopVoiceStreaming(false);
      retireVoiceSocket(wsRef.current);
    }
    cancelCamera();
    setCompleteCountdown(0);
    setVoiceRecommendation(null);
    setStartPhase('idle');
    setError('');
    setReceipt(null);
    changeLanguage('ko');
    setMessage('환영합니다. 음성 또는 화면 터치로 주문을 시작하세요.');
    setKioskStage('welcome');
    setCurrentScreen('menu');
  };
  const chooseTouchOrder = () => {
    cancelCamera();
    if (voiceStartingRef.current || voiceSessionRef.current || voiceWaitRef.current.active) {
      stopVoiceStreaming(false);
      retireVoiceSocket(wsRef.current);
    }
    setCurrentScreen('menu');
  };
  useEffect(() => {
    if (currentScreen !== 'ageResult') { cancelCamera(); return undefined; }
    const hidden = () => { if (document.visibilityState === 'hidden') cancelCamera(); };
    const leave = () => cancelCamera();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      cancelCamera();
    };
  }, [currentScreen]);
  useEffect(() => {
    if (isRecording || checkoutBusy || isPaymentWidgetLoading) cancelCamera();
  }, [isRecording, checkoutBusy, isPaymentWidgetLoading]);
  useEffect(() => {
    if (currentScreen !== 'complete') return undefined;
    if (completeCountdown <= 0) {
      returnToWelcome();
      return undefined;
    }
    const timer = setTimeout(() => setCompleteCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [currentScreen, completeCountdown]);

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
    setKioskStage('ordering');
    setCompleteCountdown(COMPLETE_RETURN_SECONDS);
    setCurrentScreen('complete');
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
    menuSourceRef.current = 'loading';
    setMenuSource('loading');
    setMenuError('');
    try {
      const menus = normalizeMenus(await kioskApi.fetchMenus({ signal: controller.signal }));
      if (controller.signal.aborted || !appMountedRef.current) return;
      const categories = groupMenus(menus);
      adminMenuItemsRef.current = menus;
      setAdminMenuItems(menus);
      setMenuCatalog(categories);
      menuSourceRef.current = 'server';
      setMenuSource('server');
      setSelectedCategory((selected) => categories.some((category) => category.id === selected) ? selected : categories[0]?.id || '');
      setOptionSelections({});
    } catch (failure) {
      if (!controller.signal.aborted && appMountedRef.current) {
        menuSourceRef.current = 'error';
        setMenuSource('error');
        setMenuError(`메뉴 서버: ${failure.message}`);
      }
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
    if (!window.confirm(translate('이 결제를 취소하시겠습니까?', languageRef.current))) return;
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

  const renderMenuImage = (item) => <MenuImage key={item.imageUrl || 'missing'} item={item} language={language} />;

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
      <p>{`${session.role === 'ADMIN' ? '관리자' : '직원'}로 로그인되어 있습니다.`}</p>
      <button type="button" disabled={authBusy || adminAction !== null || kdsUpdating !== null} onClick={logout}>로그아웃</button>
      {screen === 'admin' && session.role !== 'ADMIN' && <p className="error">관리자 권한이 필요합니다.</p>}
    </> : <form onSubmit={login} className="login-form">
      <p>{`${screen === 'admin' ? '관리자' : '주방 직원'} 로그인이 필요합니다.`}</p>
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
        <LanguageSelector language={language} onChange={selectLanguageManually} />
      </div>
      <nav className="nav-buttons" aria-label="화면 이동">
        {[
          ['menu', '메뉴'],
          ['recommendations', '추천'],
          ['cart', `장바구니 ${totalQuantity}`],
          ['kds', 'KDS'],
          ['admin', '관리자'],
        ].map(([screen, label]) => (
          <button
            key={screen}
            disabled={checkoutBusy}
            className={currentScreen === screen ? 'active' : ''}
            onClick={() => {
              if (!paymentBusyRef.current && screen !== currentScreenRef.current) {
                cancelCamera();
                setCurrentScreen(screen);
              }
            }}
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
      <div>카메라: {snapshotStatus}</div>
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
        {menuSource !== 'server' && !menuLoading && <p className="hint">{menuCatalog.length
          ? '표시된 메뉴는 마지막으로 불러온 정보입니다. 서버 메뉴를 다시 불러온 뒤 주문할 수 있습니다.'
          : '서버 메뉴를 다시 불러온 뒤 주문할 수 있습니다.'}</p>}
        <button type="button" disabled={menuLoading || checkoutBusy} onClick={loadMenus}>메뉴 다시 불러오기</button>
        {needSnapshotTouch && <p className="hint">화면 터치로 주문할 수 있습니다.</p>}
        <div className="action-row">
          <button className="primary" disabled={voiceFinalizing} onClick={isRecording ? finishVoiceStreaming : startVoiceStreaming}>
            {voiceFinalizing ? '음성 처리 중…' : isRecording ? '음성 중지' : '음성 시작'}
          </button>
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
        {!menuLoading && !menuError && menuSource === 'server' && !selectedItems.length && <p className="empty">현재 표시할 판매 메뉴가 없습니다.</p>}
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

  const renderWelcome = () => (
    <main className="screen welcome-screen">
      <video ref={videoRef} className="camera-preview welcome-camera" hidden={startPhase !== 'analyzing'} muted playsInline aria-label="카메라 미리보기" />
      {startPhase === 'analyzing' && <p className="welcome-status" role="status" aria-live="polite">잠시 화면을 바라봐 주세요.</p>}
      {startPhase === 'idle' && <>
        <h2 className="welcome-title">어서 오세요</h2>
        <p className="welcome-text">음성이나 화면 터치로 주문할 수 있어요.</p>
        <button className="primary start-order-button" disabled={checkoutBusy} onClick={startOrder}>주문 시작</button>
      </>}
      {startPhase === 'senior' && <section className="senior-dialog" role="dialog" aria-modal="true" aria-labelledby="senior-dialog-title">
        <h2 id="senior-dialog-title">화면 터치로 주문하시겠어요?</h2>
        <p>화면의 메뉴를 눌러서 편하게 주문할 수 있어요.</p>
        <div className="action-row">
          <button className="primary" onClick={() => enterOrdering('touch')}>터치로 주문하기</button>
          <button onClick={() => enterOrdering('voice')}>음성으로 계속하기</button>
        </div>
      </section>}
    </main>
  );

  const renderComplete = () => (
    <main className="screen complete-screen">
      <h2 className="complete-title">주문이 완료되었습니다.</h2>
      {receipt && <>
        <p className="complete-order-number">주문번호 <strong>{receipt.orderNumber}</strong></p>
        <section className="complete-items">
          {(receipt.items || []).map((item, index) => <p key={item.lineId || `${item.menuId}-${index}`}>
            {item.menuNameKo} {item.quantity}개 · {formatPrice(item.subtotal ?? item.unitPrice * item.quantity)}
          </p>)}
          <strong>총액 {formatPrice(receipt.totalPrice)}</strong>
        </section>
      </>}
      <p className="hint" role="status" aria-live="polite">{`${completeCountdown}초 후 처음 화면으로 돌아갑니다.`}</p>
      <button className="primary" onClick={returnToWelcome}>처음으로</button>
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
        <button className="primary" disabled={!cart.length && !hasAuthenticatedPayment} onClick={() => setCurrentScreen('payment')}>
          {hasAuthenticatedPayment ? '결제 결과 확인' : '결제하기'}
        </button>
      </div>
    </main>
  );

  const renderVoiceRecommendations = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>추천 메뉴</h2>
        <p>말씀하신 내용에 맞춰 고른 메뉴입니다.</p>
      </div>
      <p className="hint">요청: {voiceRecommendation.query}</p>
      <div className="recommendation-list">
        {voiceRecommendation.items.map(({ menu, reason }) => {
          const current = allMenuItems.find((item) => item.menuId === menu.menuId) || menu;
          return (
            <article key={current.id} className="recommendation-card">
              <div className="item-image">{renderMenuImage(current)}</div>
              <h3>{current.name}</h3>
              <p>{formatPrice(current.price)}</p>
              {reason && <p className="recommendation-reason">{reason}</p>}
              <button className="primary" disabled={menuSource !== 'server' || current.status !== 'ACTIVE' || checkoutBusy} onClick={() => addToCart(current)}>장바구니 담기</button>
            </article>
          );
        })}
      </div>
      <p className="hint">다른 추천을 원하시면 음성 시작을 누르고 다시 말씀해 주세요.</p>
    </main>
  );

  const renderRecommendations = () => voiceRecommendation ? renderVoiceRecommendations() : (
    <main className="screen">
      <div className="screen-heading">
        <h2>추천 메뉴</h2>
        <p>현재 판매 중이며 장바구니에 없는 메뉴를 보여줍니다.</p>
      </div>
      {menuSource !== 'server' && <p className="hint">서버 메뉴를 불러온 뒤 추천 메뉴를 확인할 수 있습니다.</p>}
      {menuSource === 'server' && !visibleRecommendations.length && <p className="empty">현재 추가로 추천할 판매 메뉴가 없습니다.</p>}
      <div className="recommendation-list">
        {visibleRecommendations.map((item) => (
          <article key={item.id} className="recommendation-card">
            <div className="item-image">{renderMenuImage(item)}</div>
            <h3>{item.name}</h3>
            <p>{formatPrice(item.price)}</p>
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
      <p className="age-number">{Number.isFinite(ageEstimate) ? `${ageEstimate}세` : '결과 대기'}</p>
      <p>고대비 UI를 켜거나 판매 중인 메뉴를 확인할 수 있습니다.</p>
      <p className="hint">{Number.isFinite(ageEstimate)
        ? ageSource === 'camera' ? '카메라 분석 결과는 추정값이며 실제 나이와 다를 수 있습니다.' : '음성 서버에서 수신한 연령 추정 결과입니다.'
        : '카메라를 켠 뒤 촬영 후 분석을 눌러 주세요.'}</p>
      <p className="hint">촬영 후 분석을 누르면 사진 한 장을 나이 분석 서버로 전송합니다. 사진은 이 기기에 저장하지 않습니다.</p>
      <p className="hint">나이에 따른 자동 모드 전환은 적용하지 않습니다. 터치 주문은 직접 선택할 수 있습니다.</p>
      <video ref={videoRef} className="camera-preview" hidden={!['opening', 'preview', 'capturing'].includes(cameraState.phase)}
        muted playsInline aria-label="카메라 미리보기" />
      <p role="status" aria-live="polite">카메라: {snapshotStatus}</p>
      {cameraState.error && <p className="error" role="alert">{cameraState.error.message}</p>}
      <div className="action-row">
        <button onClick={openCamera} disabled={cameraProcessing || cameraState.phase === 'preview'}>카메라 켜기</button>
        <button className="primary" onClick={analyzeCamera} disabled={cameraState.phase !== 'preview'}>촬영 후 분석</button>
        <button onClick={cancelCamera} disabled={cameraState.phase === 'idle'}>카메라 종료 · 취소</button>
      </div>
      <div className="action-row">
        <button onClick={() => setHighContrast(true)}>고대비 UI 켜기</button>
        <button onClick={() => { cancelCamera(); setCurrentScreen('menu'); }}>메뉴로 돌아가기</button>
        <button onClick={chooseTouchOrder}>터치로 주문하기</button>
      </div>
    </main>
  );

  const renderKds = () => (
    <main className="screen">
      <div className="screen-heading">
        <h2>KDS 주문 현황</h2>
        <button className="primary" disabled={!cart.length || checkoutBusy} onClick={submitOrderToKds}>현재 장바구니 결제</button>
      </div>
      {renderReceipt()}
      {paymentError && <p className="error" role="alert">{typeof paymentError === 'string' ? paymentError : paymentError.message}</p>}
      {renderLogin('kds')}
      {session && <>
        <div className="action-row"><button disabled={kdsLoading || kdsUpdating !== null} onClick={() => loadKdsOrders()}>주문 새로고침</button><span>실시간 주문: {statusLabel[kdsStreamStatus] || kdsStreamStatus}</span></div>
        {kdsError && <p className="error" role="alert">{kdsError}</p>}
        {kdsLoading && <p role="status">주문을 불러오는 중입니다.</p>}
        {!kdsLoading && !kdsError && !kdsOrders.length && <p className="empty">대기 주문이 없습니다.</p>}
        <div className="kds-list">
          {kdsOrders.map((order) => <article key={order.id} className="kds-card">
            <div><h3>{order.number}</h3><p>{orderSummary(order, language)}</p><small>{new Date(order.orderedAt).toLocaleTimeString(localeFor(language), { hour: '2-digit', minute: '2-digit' })} / 수량 {order.qty}</small></div>
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
          <input type="checkbox" checked={seniorDemo} onChange={(event) => setSeniorDemo(event.target.checked)} />
          시연 모드: 주문 시작 시 60세 이상 안내 표시
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={ttsEnabled} onChange={(event) => setTtsEnabled(event.target.checked)} />
          TTS 안내 멘트
        </label>
        <div className="action-row">
          <button onClick={() => { retryCountRef.current = 0; setRetryCount(0); connectWebSocket(); }}>WebSocket 재연결</button>
          <button onClick={() => addAuditLog('관리자 점검', '수동 점검 로그 추가', 'admin')}>감사 로그 추가</button>
          <button disabled={checkoutBusy || isRecording} onClick={openAgeAnalysis}>카메라 나이 분석 테스트</button>
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
              <p>{log.createdAt ? new Date(log.createdAt).toLocaleString(localeFor(language)) : log.time} / {log.user}</p>
              <small>{log.detail}</small>
            </article>
          ))}
        </div>
      </section>
      <section className="server-admin">
        <h2>매장 관리</h2>
        {renderLogin('admin')}
        {session?.role === 'ADMIN' && renderAdminServer()}
      </section>
    </main>
  );

  aiMessageHandlerRef.current = handleAiMessage;
  speakRef.current = speak;

  return localizeTree(
    <div lang={language} className={`App ${highContrast ? 'high-contrast' : ''}`}>
      {renderTopBar()}
      {renderSystemPanel()}
      {cameraProcessing && <div className="loading">처리 중...</div>}
      {aiResponsePending && (
        <div className="loading ai-pending" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          AI가 주문을 인식하고 있어요…
        </div>
      )}
      {currentScreen === 'menu' && (kioskStage === 'welcome' ? renderWelcome() : renderMenu())}
      {currentScreen === 'complete' && renderComplete()}
      {currentScreen === 'cart' && renderCart()}
      {currentScreen === 'recommendations' && renderRecommendations()}
      {currentScreen === 'payment' && renderPayment()}
      {currentScreen === 'ageResult' && renderAgeResult()}
      {currentScreen === 'kds' && renderKds()}
      {currentScreen === 'admin' && renderAdmin()}
    </div>, language,
  );
}

export default App;
