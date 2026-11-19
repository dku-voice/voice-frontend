import React, { useState } from 'react';
import { translate } from '../i18n/index.js';

export default function MenuImage({ item, language = 'ko' }) {
  const [failed, setFailed] = useState(false);
  if (!item.imageUrl || failed) return <span role="img" aria-label={translate(`${item.name} 이미지 없음`, language)}>{translate('이미지 없음', language)}</span>;
  return <img src={item.imageUrl} alt={translate(item.name, language)} loading="lazy" onError={() => setFailed(true)} />;
}
