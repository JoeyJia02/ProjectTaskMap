import { useRef, useState } from 'react';
import type { Operation } from './types';

export function QuickIdea({ busy, onSave }: { busy: boolean; onSave: (operations: Operation[]) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  return <form className="quick-idea" onSubmit={async event => {
    event.preventDefault();
    if (!text.trim() || busy || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try { if (await onSave([{ type: 'ADD_NODE', node: { id: crypto.randomUUID(), title: text.trim(), status: 'parking' } }])) setText(''); }
    finally { inFlight.current = false; setSaving(false); }
  }}><input aria-label="随手记想法" placeholder="随手记想法，回车保存；关联任务可稍后补充" maxLength={300} value={text} disabled={saving} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} /><button className="button" disabled={busy || saving || !text.trim()}>{saving ? '保存中…' : '记下'}</button></form>;
}
