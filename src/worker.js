const reduceNoiseFallback = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const processed = new Uint8Array(bytes.length);

  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    processed[index] = value < 4 ? 0 : value;
  }

  return processed.buffer;
};

self.onmessage = (event) => {
  if (event.data?.type !== 'reduce-noise') return;

  const processedBuffer = reduceNoiseFallback(event.data.buffer);
  self.postMessage(
    {
      type: 'noise-reduced',
      buffer: processedBuffer,
      engine: 'fallback-worker',
    },
    [processedBuffer],
  );
};
