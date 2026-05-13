// worker.js - Simple noise reduction simulation
self.onmessage = function(e) {
  const audioData = e.data;
  // Simulate noise reduction (just pass through for now)
  const processedData = audioData; // TODO: Apply RNNoise WASM
  self.postMessage(processedData);
};