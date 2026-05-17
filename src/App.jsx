import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import { loadPaymentWidget } from '@tosspayments/payment-widget-sdk';

const worker = new Worker(new URL('./worker.js', import.meta.url));

const menus = {
  categories: [
    { id: 1, name: '커피', items: [
      { id: 1, name: '아메리카노', price: 3000 },
      { id: 2, name: '카페라떼', price: 4000 },
      { id: 3, name: '카푸치노', price: 4500 },
    ] },
    { id: 2, name: '디저트', items: [
      { id: 4, name: '쿠키', price: 2000 },
      { id: 5, name: '케이크', price: 5000 },
      { id: 6, name: '머핀', price: 2500 },
    ] },
    { id: 3, name: '음료', items: [
      { id: 7, name: '주스', price: 3500 },
      { id: 8, name: '스무디', price: 4000 },
    ] },
  ],
};

const sampleAuditLogs = [
  { id: 1, time: '2026-05-17 10:08', event: '관리자 로그인', user: 'admin', detail: 'IP 192.168.0.21' },
  { id: 2, time: '2026-05-17 10:12', event: 'KDS 주문 수신', user: 'system', detail: '주문 ID(order-1234) 처리' },
  { id: 3, time: '2026-05-17 10:16', event: 'AI 응답 지연', user: 'system', detail: '5초 초과, 사용자 스냅샷 대기' },
];

const sampleKdsOrders = [
  { id: 'KDS-001', menu: '아메리카노', qty: 2, status: '조리 중' },
  { id: 'KDS-002', menu: '카페라떼', qty: 1, status: '완료 대기' },
  { id: 'KDS-003', menu: '쿠키', qty: 3, status: '조리 대기' },
];

function App() {
  const [currentScreen, setCurrentScreen] = useState('menu');
  const [cart, setCart] = useState([]);
  const [ws, setWs] = useState(null);
  const [wsStatus, setWsStatus] = useState('closed');
  const [retryCount, setRetryCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState(null);
  const [videoStream, setVideoStream] = useState(null);
  const [message, setMessage] = useState('환영합니다. 음성 또는 화면으로 주문을 시작하세요.');
  const [error, setError] = useState(null);
  const [ageEstimate, setAgeEstimate] = useState(null);
  const [highContrast, setHighContrast] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [needSnapshotTouch, setNeedSnapshotTouch] = useState(false);
  const [recommendations, setRecommendations] = useState([]);
  const [adminLogs, setAdminLogs] = useState(sampleAuditLogs);
  const [kdsOrders, setKdsOrders] = useState(sampleKdsOrders);
  const [loading, setLoading] = useState(false);
  const [responseDelayTriggered, setResponseDelayTriggered] = useState(false);

  const mediaRecorderRef = useRef(null);
  const responseTimeoutRef = useRef(null);
  const wsRef = useRef(null);
  const videoRef = useRef(null);
  const lastSentAudioRef = useRef(null);

  const speakTTS = (text) => {
    setMessage(text);
    if (ttsEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ko-KR';
      window.speechSynthesis.speak(utterance);
    }
  };

  useEffect(() => {
    connectWS();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (ageEstimate) {
      setCurrentScreen('ageResult');
      speakTTS(`고객님의 예상 연령은 ${ageEstimate}세입니다. 추천 메뉴를 확인해 주세요.`);
    }
  }, [ageEstimate]);

  useEffect(() => {
    if (cart.length > 0) {
      setRecommendations(getRecommendations(cart));
    }
  }, [cart]);

  const scheduleResponseTimeout = () => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
    }
    setResponseDelayTriggered(false);
    responseTimeoutRef.current = window.setTimeout(() => {
      setResponseDelayTriggered(true);
      setNeedSnapshotTouch(true);
      speakTTS('서버 응답이 지연되고 있습니다. 화면을 터치하면 스냅샷을 전송합니다.');
    }, 5000);
  };

  const clearResponseTimeout = () => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
    setResponseDelayTriggered(false);
    setNeedSnapshotTouch(false);
  };

  const connectWS = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }
    setWsStatus('connecting');
    const websocket = new WebSocket('ws://localhost:8000/ws/audio');
    wsRef.current = websocket;

    websocket.onopen = () => {
      setWsStatus('open');
      setRetryCount(0);
      setWs(websocket);
      speakTTS('AI 서버와 연결되었습니다. 음성 명령을 기다립니다.');
    };

    websocket.onmessage = (event) => {
      clearResponseTimeout();
      setNeedSnapshotTouch(false);

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.error('Invalid WS message', err);
        return;
      }

      if (data.type === 'order') {
        addToCart(data.item);
        speakTTS(`${data.item.name}이(가) 장바구니에 담겼습니다.`);
      }
      if (data.type === 'age_estimate') {
        setAgeEstimate(data.age);
      }
      if (data.type === 'recommendation') {
        setRecommendations(data.items || []);
      }
      if (data.type === 'kds_status') {
        setKdsOrders((prev) => [...prev, data.order]);
      }
    };

    websocket.onclose = () => {
      setWsStatus('closed');
      setWs(null);
      speakTTS('AI 서버 연결이 끊어졌습니다. 재연결을 시도합니다.');
      retryWebSocket();
    };

    websocket.onerror = () => {
      setWsStatus('error');
      setError('WebSocket 오류가 발생했습니다.');
    };
  };

  const retryWebSocket = () => {
    const nextRetry = Math.min(retryCount + 1, 5);
    setRetryCount(nextRetry);
    const delay = nextRetry * 2000;
    setTimeout(connectWS, delay);
  };

  const addToCart = (item) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.id === item.id);
      if (existing) {
        return prev.map((c) => (c.id === item.id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      return [...prev, { ...item, quantity: 1 }];
    });
  };

  const removeFromCart = (id) => {
    setCart((prev) => prev.filter((c) => c.id !== id));
  };

  const updateQuantity = (id, quantity) => {
    if (quantity <= 0) {
      removeFromCart(id);
      return;
    }
    setCart((prev) => prev.map((item) => (item.id === id ? { ...item, quantity } : item)));
  };

  const getTotalPrice = () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const handlePayment = async () => {
    try {
      const paymentWidget = await loadPaymentWidget('test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq', 'payment-widget');
      paymentWidget.renderPaymentMethods('#payment-widget', getTotalPrice());
      paymentWidget.requestPayment({
        orderId: 'order-' + Date.now(),
        orderName: '키오스크 주문',
        successUrl: window.location.origin + '/success',
        failUrl: window.location.origin + '/fail',
      });
    } catch (err) {
      console.error(err);
      setError('결제 위젯 로드에 실패했습니다.');
    }
  };

  const sendAudioToServer = (buffer) => {
    if (!buffer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (lastSentAudioRef.current === buffer) return;
    lastSentAudioRef.current = buffer;
    wsRef.current.send(buffer);
    scheduleResponseTimeout();
  };

  const startVoiceStreaming = async () => {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStream(audioStream);
      const mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          event.data.arrayBuffer().then((buffer) => {
            worker.postMessage(buffer);
            sendAudioToServer(buffer);
          });
        }
      };

      worker.onmessage = (e) => {
        sendAudioToServer(e.data);
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      speakTTS('음성 인식이 시작되었습니다. 원하시는 메뉴를 말씀하세요.');
    } catch (error) {
      console.error('Error accessing microphone:', error);
      setError('마이크 접근 권한이 필요합니다.');
    }
  };

  const stopVoiceStreaming = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      speakTTS('음성 인식을 종료했습니다.');
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
  };

  const captureSnapshot = async () => {
    try {
      setLoading(true);
      const currentVideoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      setVideoStream(currentVideoStream);
      if (videoRef.current) {
        videoRef.current.srcObject = currentVideoStream;
        videoRef.current.play();
        setTimeout(() => {
          const canvas = document.createElement('canvas');
          canvas.width = videoRef.current.videoWidth;
          canvas.height = videoRef.current.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(videoRef.current, 0, 0);
          canvas.toBlob(async (blob) => {
            const formData = new FormData();
            formData.append('snapshot', blob, 'snapshot.jpg');
            try {
              const response = await fetch('http://localhost:8000/snapshot', {
                method: 'POST',
                body: formData,
              });
              if (response.ok) {
                speakTTS('스냅샷이 전송되었습니다.');
              } else {
                setError('스냅샷 전송에 실패했습니다.');
              }
            } catch (error) {
              console.error('Error sending snapshot:', error);
              setError('AI 서버로 스냅샷을 전송할 수 없습니다.');
            }
            currentVideoStream.getTracks().forEach((track) => track.stop());
            setVideoStream(null);
            setLoading(false);
            clearResponseTimeout();
          }, 'image/jpeg');
        }, 1000);
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
      setError('카메라 접근 권한이 필요합니다.');
      setLoading(false);
    }
  };

  const handleTouchSnapshot = () => {
    if (needSnapshotTouch) {
      captureSnapshot();
    }
  };

  const getRecommendations = (cartItems) => {
    const recommendations = [];
    if (cartItems.some((item) => item.id === 1)) {
      recommendations.push({ id: 2, name: '카페라떼', price: 4000 });
    }
    if (cartItems.some((item) => item.id === 4)) {
      recommendations.push({ id: 5, name: '케이크', price: 5000 });
    }
    return recommendations;
  };

  const renderTopBar = () => (
    <div className="top-bar">
      <button onClick={() => setHighContrast(!highContrast)}>
        {highContrast ? '고대비 모드 끄기' : '고대비 모드 켜기'}
      </button>
      <button onClick={() => setCurrentScreen('menu')}>메뉴</button>
      <button onClick={() => setCurrentScreen('cart')}>장바구니</button>
      <button onClick={() => setCurrentScreen('recommendations')}>추천</button>
      <button onClick={() => setCurrentScreen('kds')}>KDS</button>
      <button onClick={() => setCurrentScreen('admin')}>관리자</button>
    </div>
  );

  const renderMenu = () => (
    <div className="screen">
      <h1>메뉴 선택</h1>
      <p className="status">AI 서버: {wsStatus} {responseDelayTriggered ? '(응답 지연 중)' : ''}</p>
      <p className="message">{message}</p>
      {error && <p className="error">{error}</p>}
      <div className="action-row">
        <button onClick={isRecording ? stopVoiceStreaming : startVoiceStreaming}>
          {isRecording ? '음성 중지' : '음성 시작'}
        </button>
        <button onClick={captureSnapshot}>스냅샷 캡처</button>
      </div>
      {needSnapshotTouch && <p className="hint">서버 응답 지연! 화면을 터치하면 스냅샷을 전송합니다.</p>}
      <div className="category-list">
        {menus.categories.map((category) => (
          <div key={category.id} className="category-card">
            <h2>{category.name}</h2>
            <div className="item-grid">
              {category.items.map((item) => (
                <div key={item.id} className="item-card">
                  <h3>{item.name}</h3>
                  <p>가격: {item.price}원</p>
                  <button onClick={() => addToCart(item)}>담기</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setCurrentScreen('cart')} className="primary">
        장바구니 보기 ({cart.length})
      </button>
      <video ref={videoRef} style={{ display: 'none' }} />
    </div>
  );

  const renderCart = () => (
    <div className="screen">
      <h1>장바구니</h1>
      {cart.length === 0 ? (
        <p>장바구니가 비어 있습니다.</p>
      ) : (
        <div className="cart-list">
          {cart.map((item) => (
            <div key={item.id} className="cart-item">
              <h3>{item.name}</h3>
              <p>가격: {item.price}원</p>
              <div className="quantity-controls">
                <button onClick={() => updateQuantity(item.id, item.quantity - 1)}>-</button>
                <span>{item.quantity}</span>
                <button onClick={() => updateQuantity(item.id, item.quantity + 1)}>+</button>
              </div>
              <p>총: {item.price * item.quantity}원</p>
              <button onClick={() => removeFromCart(item.id)}>제거</button>
            </div>
          ))}
          <h2>총 가격: {getTotalPrice()}원</h2>
        </div>
      )}
      <div className="action-row">
        <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
        {cart.length > 0 && <button onClick={() => setCurrentScreen('payment')}>결제하기</button>}
      </div>
    </div>
  );

  const renderPayment = () => (
    <div className="screen">
      <h1>결제</h1>
      <p>총 금액: {getTotalPrice()}원</p>
      <div id="payment-widget"></div>
      <div className="action-row">
        <button onClick={handlePayment}>결제 진행</button>
        <button onClick={() => setCurrentScreen('cart')}>장바구니로 돌아가기</button>
      </div>
    </div>
  );

  const renderAgeResult = () => (
    <div className="screen">
      <h1>연령 추정 결과</h1>
      <p>예상 연령: {ageEstimate}세</p>
      <p>추천 메뉴를 확인하세요.</p>
      <div className="action-row">
        <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
        <button onClick={() => setCurrentScreen('recommendations')}>추천 보기</button>
      </div>
    </div>
  );

  const renderRecommendations = () => (
    <div className="screen">
      <h1>추천 메뉴</h1>
      {recommendations.length === 0 ? (
        <p>장바구니에 따라 추천 메뉴가 준비됩니다.</p>
      ) : (
        <div className="recommendation-list">
          {recommendations.map((item) => (
            <div key={item.id} className="recommendation-card">
              <h3>{item.name}</h3>
              <p>가격: {item.price}원</p>
              <button onClick={() => addToCart(item)}>장바구니에 추가</button>
            </div>
          ))}
        </div>
      )}
      <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
    </div>
  );

  const renderKds = () => (
    <div className="screen">
      <h1>KDS 대시보드</h1>
      <p>주방 알림 및 주문 상태를 확인하세요.</p>
      <div className="kds-list">
        {kdsOrders.map((order) => (
          <div key={order.id} className="kds-card">
            <h3>{order.id}</h3>
            <p>메뉴: {order.menu}</p>
            <p>수량: {order.qty}</p>
            <p>상태: {order.status}</p>
          </div>
        ))}
      </div>
      <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
    </div>
  );

  const renderAdmin = () => (
    <div className="screen">
      <h1>관리자 페이지</h1>
      <p>보안 감사지 로그와 KDS 상태를 점검합니다.</p>
      <div className="audit-list">
        {adminLogs.map((log) => (
          <div key={log.id} className="audit-card">
            <p><strong>{log.time}</strong> - {log.event}</p>
            <p>{log.user} / {log.detail}</p>
          </div>
        ))}
      </div>
      <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
    </div>
  );

  return (
    <div className={`App ${highContrast ? 'high-contrast' : ''}`} onPointerDown={handleTouchSnapshot}>
      {renderTopBar()}
      {loading && <div className="loading">로딩 중...</div>}
      {currentScreen === 'menu' && renderMenu()}
      {currentScreen === 'cart' && renderCart()}
      {currentScreen === 'payment' && renderPayment()}
      {currentScreen === 'ageResult' && renderAgeResult()}
      {currentScreen === 'recommendations' && renderRecommendations()}
      {currentScreen === 'kds' && renderKds()}
      {currentScreen === 'admin' && renderAdmin()}
      <video ref={videoRef} style={{ display: 'none' }} />
    </div>
  );
}

export default App;
