'use client';
import { useEffect, useState } from 'react';
export default function Timer({ endsAt }: { endsAt: string | null }) {
  const [left, setLeft] = useState('--:--');
  useEffect(() => {
    if (!endsAt) { setLeft('--:--'); return; }
    const tick = () => { const s = Math.max(0, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000)); setLeft(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, [endsAt]);
  return <strong aria-label="Time remaining">{left}</strong>;
}
