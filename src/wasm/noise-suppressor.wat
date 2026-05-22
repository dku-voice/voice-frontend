(module
  ;; ==========================================================================
  ;;  noise-suppressor.wat  --  WASM 기반 노이즈 캔슬링 DSP
  ;;
  ;;  적응형 broadband noise suppressor. 프레임 단위로 들어온 f32 PCM 을
  ;;  in-place 로 디노이즈한다.
  ;;
  ;;    1) 1-pole 하이패스 필터  : DC offset + 저주파 험(HVAC/팬 소음) 제거
  ;;    2) 엔벨로프 팔로워       : 빠른 attack / 느린 release 로 신호 레벨 추정
  ;;    3) 적응형 노이즈 플로어  : 조용한 구간으로 빠르게 하강, 음성 구간엔 매우
  ;;                              느리게 상승 -> 정상 잡음(ambient) 레벨에 수렴
  ;;    4) 스펙트럴 서브트랙션형 게인 : g = f(SNR), 음성은 통과 / 잡음은 감쇠
  ;;    5) 게인 스무딩           : zipper noise(게이트 떨림) 방지
  ;;
  ;;  빌드: wat2wasm noise-suppressor.wat -o noise-suppressor.wasm
  ;;
  ;;  exports:
  ;;    memory                    -- 선형 메모리 (2 pages = 128 KiB)
  ;;    bufferPtr : i32           -- PCM 스크래치 버퍼의 바이트 오프셋
  ;;    init(sampleRate:f32)      -- 상태 초기화 + 샘플레이트별 시정수 산출
  ;;    process(ptr:i32, len:i32) -- ptr 위치의 f32 PCM len 개를 in-place 디노이즈
  ;; ==========================================================================
  (memory (export "memory") 2)
  (global (export "bufferPtr") i32 (i32.const 256))

  ;; --- 필터 / 적응 상태 ---
  (global $hpA        (mut f32) (f32.const 0.96))
  (global $hpPrevIn   (mut f32) (f32.const 0))
  (global $hpPrevOut  (mut f32) (f32.const 0))
  (global $envelope   (mut f32) (f32.const 0))
  (global $noiseFloor (mut f32) (f32.const 0.0001))
  (global $gateGain   (mut f32) (f32.const 0))

  ;; --- 샘플레이트로부터 init() 에서 산출되는 1-pole 시정수 계수 ---
  (global $attack    (mut f32) (f32.const 0.0125))
  (global $release   (mut f32) (f32.const 0.00078))
  (global $nfFall    (mut f32) (f32.const 0.00042))
  (global $nfRise    (mut f32) (f32.const 0.0000156))
  (global $gateCoef  (mut f32) (f32.const 0.0042))

  ;; 잔여 게인(완전 묵음 방지 -> 펌핑 아티팩트 완화)
  (global $residual  f32 (f32.const 0.06))

  ;; init(sampleRate): 시정수 = 1 / (tau * sampleRate)
  (func (export "init") (param $sr f32)
    ;; hpA = max(0.80, 1 - 2*pi*90 / sr)   (2*pi*90 ~= 565.4867, 컷오프 ~90Hz)
    (global.set $hpA
      (f32.max (f32.const 0.80)
        (f32.sub (f32.const 1.0)
          (f32.div (f32.const 565.4867) (local.get $sr)))))
    (global.set $attack   (f32.div (f32.const 1) (f32.mul (f32.const 0.005) (local.get $sr))))
    (global.set $release  (f32.div (f32.const 1) (f32.mul (f32.const 0.080) (local.get $sr))))
    (global.set $nfFall   (f32.div (f32.const 1) (f32.mul (f32.const 0.150) (local.get $sr))))
    (global.set $nfRise   (f32.div (f32.const 1) (f32.mul (f32.const 4.000) (local.get $sr))))
    (global.set $gateCoef (f32.div (f32.const 1) (f32.mul (f32.const 0.015) (local.get $sr))))
    ;; 상태 리셋
    (global.set $hpPrevIn   (f32.const 0))
    (global.set $hpPrevOut  (f32.const 0))
    (global.set $envelope   (f32.const 0))
    (global.set $noiseFloor (f32.const 0.0001))
    (global.set $gateGain   (f32.const 0)))

  ;; process(ptr, len): ptr 위치의 f32 PCM len 개를 in-place 디노이즈
  (func (export "process") (param $ptr i32) (param $len i32)
    (local $i i32)
    (local $addr i32)
    (local $x f32)
    (local $hp f32)
    (local $level f32)
    (local $envCoef f32)
    (local $snr f32)
    (local $target f32)
    (local $gain f32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $addr
          (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $x (f32.load (local.get $addr)))

        ;; 1) 하이패스: hp = hpA * (prevOut + x - prevIn)
        (local.set $hp
          (f32.mul (global.get $hpA)
            (f32.add (global.get $hpPrevOut)
              (f32.sub (local.get $x) (global.get $hpPrevIn)))))
        (global.set $hpPrevIn  (local.get $x))
        (global.set $hpPrevOut (local.get $hp))

        ;; 2) 엔벨로프 (|hp|, 빠른 attack / 느린 release)
        (local.set $level (f32.abs (local.get $hp)))
        (local.set $envCoef
          (select (global.get $attack) (global.get $release)
            (f32.gt (local.get $level) (global.get $envelope))))
        (global.set $envelope
          (f32.add (global.get $envelope)
            (f32.mul (local.get $envCoef)
              (f32.sub (local.get $level) (global.get $envelope)))))

        ;; 3) 적응형 노이즈 플로어 (조용하면 빠르게 하강, 아니면 느리게 상승)
        (global.set $noiseFloor
          (f32.add (global.get $noiseFloor)
            (f32.mul
              (select (global.get $nfFall) (global.get $nfRise)
                (f32.lt (global.get $envelope) (global.get $noiseFloor)))
              (f32.sub (global.get $envelope) (global.get $noiseFloor)))))

        ;; 4) SNR 기반 게인:  snr = env / noiseFloor
        ;;    target = (snr - 1.5) / (snr + 1.5), [0,1] 클램프
        (local.set $snr
          (f32.div (global.get $envelope)
            (f32.add (global.get $noiseFloor) (f32.const 0.000000001))))
        (local.set $target
          (f32.div
            (f32.sub (local.get $snr) (f32.const 1.5))
            (f32.add (local.get $snr) (f32.const 1.5))))
        (local.set $target
          (f32.max (f32.const 0)
            (f32.min (f32.const 1) (local.get $target))))

        ;; 5) 게인 스무딩 (zipper noise 방지)
        (global.set $gateGain
          (f32.add (global.get $gateGain)
            (f32.mul (global.get $gateCoef)
              (f32.sub (local.get $target) (global.get $gateGain)))))

        ;; 최종 게인 = residual + (1-residual)*gateGain, 하이패스 샘플에 적용
        (local.set $gain
          (f32.add (global.get $residual)
            (f32.mul
              (f32.sub (f32.const 1.0) (global.get $residual))
              (global.get $gateGain))))
        (f32.store (local.get $addr)
          (f32.mul (local.get $hp) (local.get $gain)))

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))))
