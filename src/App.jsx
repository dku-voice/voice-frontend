import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import { loadPaymentWidget } from '@tosspayments/payment-widget-sdk';

const worker = new Worker(new URL('./worker.js', import.meta.url));

// Dummy menu data
const menus = {
  categories: [
    { id: 1, name: '커피', items: [
      { id: 1, name: '아메리카노', price: 3000 },
      { id: 2, name: '카페라떼', price: 4000 },
      { id: 3, name: '카푸치노', price: 4500 },
    ]},
    { id: 2, name: '디저트', items: [
      { id: 4, name: '쿠키', price: 2000 },
      { id: 5, name: '케이크', price: 5000 },
      { id: 6, name: '머핀', price: 2500 },
    ]},
    { id: 3, name: '음료', items: [
      { id: 7, name: '주스', price: 3500 },
      { id: 8, name: '스무디', price: 4000 },
    ]},
  ]
};

function App() {
  const [currentScreen, setCurrentScreen] = useState('menu'); // 'menu', 'cart', 'payment'
  const [cart, setCart] = useState([]); // [{ id, name, price, quantity }]
  const [ws, setWs] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState(null);
  const [videoStream, setVideoStream] = useState(null);
  const mediaRecorderRef = useRef(null);
  const videoRef = useRef(null);

  const addToCart = (item) => {
    setCart(prev => {
      const existing = prev.find(c => c.id === item.id);
      if (existing) {
        return prev.map(c => c.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      } else {
        return [...prev, { ...item, quantity: 1 }];
      }
    });
  };

  const removeFromCart = (id) => {
    setCart(prev => prev.filter(c => c.id !== id));
  };

  const handlePayment = async () => {
    const paymentWidget = await loadPaymentWidget('test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq', 'payment-widget'); // 테스트 키
    paymentWidget.renderPaymentMethods('#payment-widget', getTotalPrice());
    paymentWidget.requestPayment({
      orderId: 'order-' + Date.now(),
      orderName: '키오스크 주문',
      successUrl: window.location.origin + '/success',
      failUrl: window.location.origin + '/fail',
    });
  };

  const getTotalPrice = () => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  };

  const connectWS = () => {
    const websocket = new WebSocket('ws://localhost:8000/ws/audio'); // AI 서버 주소 (더미)
    websocket.onopen = () => console.log('WS connected');
    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'order') {
        addToCart(data.item);
      }
    };
    websocket.onclose = () => console.log('WS closed');
    setWs(websocket);
  };

  useEffect(() => {
    connectWS();
    return () => {
      if (ws) ws.close();
    };
  }, []);

  const startVoiceStreaming = async () => {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStream(audioStream);
      const mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          event.data.arrayBuffer().then(buffer => {
            worker.postMessage(buffer);
          });
        }
      };

      worker.onmessage = (e) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      mediaRecorder.start(100); // 100ms chunks
      setIsRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);
    }
  };

  const stopVoiceStreaming = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  const captureSnapshot = async () => {
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      setVideoStream(videoStream);
      if (videoRef.current) {
        videoRef.current.srcObject = videoStream;
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
              const response = await fetch('http://localhost:8000/snapshot', { // AI 서버 주소
                method: 'POST',
                body: formData,
              });
              if (response.ok) {
                console.log('Snapshot sent');
              }
            } catch (error) {
              console.error('Error sending snapshot:', error);
            }
            videoStream.getTracks().forEach(track => track.stop());
            setVideoStream(null);
          }, 'image/jpeg');
        }, 1000); // 1초 후 캡처
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
    }
  };

  const renderMenu = () => (
    <div>
      <h1>메뉴 선택</h1>
      <button onClick={isRecording ? stopVoiceStreaming : startVoiceStreaming}>
        {isRecording ? '음성 중지' : '음성 시작'}
      </button>
      <button onClick={captureSnapshot}>스냅샷 캡처</button>
      <video ref={videoRef} style={{ display: 'none' }} />
      {menus.categories.map(category => (
        <div key={category.id}>
          <h2>{category.name}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {category.items.map(item => (
              <div key={item.id} style={{ border: '1px solid #ccc', margin: '10px', padding: '10px', width: '150px' }}>
                <h3>{item.name}</h3>
                <p>가격: {item.price}원</p>
                <button onClick={() => addToCart(item)}>담기</button>
              </div>
            ))}
          </div>
        </div>
      ))}
      <button onClick={() => setCurrentScreen('cart')}>장바구니 보기 ({cart.length})</button>
    </div>
  );

  const renderCart = () => (
    <div>
      <h1>장바구니</h1>
      {cart.length === 0 ? (
        <p>장바구니가 비어 있습니다.</p>
      ) : (
        <div>
          {cart.map(item => (
            <div key={item.id} style={{ border: '1px solid #ccc', margin: '10px', padding: '10px' }}>
              <h3>{item.name}</h3>
              <p>가격: {item.price}원</p>
              <p>수량: 
                <button onClick={() => updateQuantity(item.id, item.quantity - 1)}>-</button>
                {item.quantity}
                <button onClick={() => updateQuantity(item.id, item.quantity + 1)}>+</button>
              </p>
              <p>총: {item.price * item.quantity}원</p>
              <button onClick={() => removeFromCart(item.id)}>제거</button>
            </div>
          ))}
          <h2>총 가격: {getTotalPrice()}원</h2>
        </div>
      )}
      <button onClick={() => setCurrentScreen('menu')}>메뉴로 돌아가기</button>
      {cart.length > 0 && <button onClick={() => setCurrentScreen('payment')}>결제하기</button>}
    </div>
  );

  const renderPayment = () => (
    <div>
      <h1>결제</h1>
      <p>총 금액: {getTotalPrice()}원</p>
      <div id="payment-widget"></div>
      <button onClick={handlePayment}>결제 진행</button>
      <button onClick={() => setCurrentScreen('cart')}>장바구니로 돌아가기</button>
    </div>
  );

  return (
    <div className="App">
      {currentScreen === 'menu' && renderMenu()}
      {currentScreen === 'cart' && renderCart()}
      {currentScreen === 'payment' && renderPayment()}
    </div>
  );
}

export default App;
