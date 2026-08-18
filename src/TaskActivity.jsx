import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};

const STATUS_LABELS = { backlog: 'Бэклог', plan: 'Планируется', work: 'В работе', check: 'Проверка', done: 'Готово' };

function bytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} Б`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} КБ`;
  return `${(size / 1024 ** 2).toFixed(1)} МБ`;
}

function dateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function safeFileName(name) {
  return String(name || 'file').normalize('NFKC').replace(/[^a-zA-Z0-9._()\-а-яА-ЯёЁ ]+/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'file';
}

function fileMime(file) {
  if (file?.type && ALLOWED_MIME_TYPES.has(file.type)) return file.type;
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  return MIME_BY_EXTENSION[extension] || file?.type || '';
}

function actorName(actorId, profiles) {
  const person = profiles.find((item) => item.id === actorId);
  return person?.full_name || 'Пользователь';
}

function historyText(item) {
  const meta = item.metadata || {};
  switch (item.event_type) {
    case 'created': return `создал задачу${meta.title ? ` «${meta.title}»` : ''}`;
    case 'status_changed': return `изменил статус: ${STATUS_LABELS[meta.old] || meta.old || '—'} → ${STATUS_LABELS[meta.new] || meta.new || '—'}`;
    case 'result_updated': return meta.current_present ? 'обновил результат задачи' : 'очистил результат задачи';
    case 'deadline_changed': return `изменил срок: ${meta.old || '—'} → ${meta.new || '—'}`;
    case 'group_changed': return `изменил группу: ${meta.old || 'Без группы'} → ${meta.new || 'Без группы'}`;
    case 'attachment_added': return `добавил файл «${meta.file_name || 'Файл'}»`;
    case 'attachment_removed': return `удалил файл «${meta.file_name || 'Файл'}»`;
    case 'comment_added': return `добавил комментарий${meta.preview ? `: «${meta.preview}»` : ''}`;
    case 'comment_updated': return `изменил комментарий${meta.preview ? `: «${meta.preview}»` : ''}`;
    case 'comment_removed': return 'удалил комментарий';
    case 'updated': return `обновил задачу${Array.isArray(meta.fields) && meta.fields.length ? `: ${meta.fields.join(', ')}` : ''}`;
    default: return 'изменил задачу';
  }
}

export default function TaskActivity({ taskId, editable, currentUserId, profiles, notify }) {
  const [attachments, setAttachments] = useState([]);
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('files');
  const fileInput = useRef(null);

  const profileMap = useMemo(() => new Map(profiles.map((item) => [item.id, item])), [profiles]);

  async function load() {
    if (!taskId) return;
    setLoading(true);
    const [filesResult, commentsResult, historyResult] = await Promise.all([
      supabase.from('task_attachments').select('id,task_id,storage_path,file_name,content_type,size_bytes,uploaded_by,created_at').eq('task_id', taskId).order('created_at', { ascending: false }),
      supabase.from('task_comments').select('id,task_id,author_id,body,created_at,updated_at').eq('task_id', taskId).order('created_at', { ascending: true }),
      supabase.from('task_history').select('id,task_id,project_id,actor_id,event_type,metadata,created_at').eq('task_id', taskId).order('created_at', { ascending: false }).limit(100),
    ]);
    const firstError = [filesResult, commentsResult, historyResult].find((result) => result.error)?.error;
    setLoading(false);
    if (firstError) {
      notify?.(`Не удалось загрузить активность задачи: ${firstError.message}`, 'error');
      return;
    }
    setAttachments(filesResult.data || []);
    setComments(commentsResult.data || []);
    setHistory(historyResult.data || []);
  }

  useEffect(() => {
    load();
    if (!taskId) return undefined;
    const refresh = () => load();
    const channel = supabase.channel(`task-activity-${taskId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_attachments', filter: `task_id=eq.${taskId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_comments', filter: `task_id=eq.${taskId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_history', filter: `task_id=eq.${taskId}` }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [taskId]);

  async function uploadFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editable) return;
    if (file.size > MAX_FILE_SIZE) return notify?.('Файл больше 15 МБ', 'error');
    const contentType = fileMime(file);
    if (!ALLOWED_MIME_TYPES.has(contentType)) return notify?.('Этот формат файла не разрешён', 'error');

    setBusy(true);
    const cleanName = safeFileName(file.name);
    const path = `${taskId}/${crypto.randomUUID()}-${cleanName}`;
    const { error: uploadError } = await supabase.storage.from('task-results').upload(path, file, { contentType, cacheControl: '3600', upsert: false });
    if (uploadError) {
      setBusy(false);
      notify?.(`Не удалось загрузить файл: ${uploadError.message}`, 'error');
      return;
    }

    const { error: metadataError } = await supabase.from('task_attachments').insert({
      task_id: taskId,
      storage_path: path,
      file_name: cleanName,
      content_type: contentType,
      size_bytes: file.size,
      uploaded_by: currentUserId,
    });

    if (metadataError) {
      await supabase.storage.from('task-results').remove([path]);
      setBusy(false);
      notify?.(`Файл не удалось привязать к задаче: ${metadataError.message}`, 'error');
      return;
    }

    setBusy(false);
    notify?.('Файл добавлен', 'success');
    await load();
  }

  async function downloadFile(item) {
    const { data, error } = await supabase.storage.from('task-results').createSignedUrl(item.storage_path, 60, { download: true });
    if (error || !data?.signedUrl) return notify?.(`Не удалось открыть файл: ${error?.message || 'signed URL не создан'}`, 'error');
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function removeFile(item) {
    if (!editable || !window.confirm(`Удалить файл «${item.file_name}»?`)) return;
    setBusy(true);
    const { error: storageError } = await supabase.storage.from('task-results').remove([item.storage_path]);
    if (storageError) {
      setBusy(false);
      return notify?.(`Не удалось удалить файл: ${storageError.message}`, 'error');
    }
    const { error: rowError } = await supabase.from('task_attachments').delete().eq('id', item.id);
    setBusy(false);
    if (rowError) return notify?.(`Файл удалён из Storage, но запись не удалена: ${rowError.message}`, 'error');
    notify?.('Файл удалён', 'success');
    await load();
  }

  async function addComment(event) {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!editable || !body) return;
    setBusy(true);
    const { error } = await supabase.from('task_comments').insert({ task_id: taskId, author_id: currentUserId, body });
    setBusy(false);
    if (error) return notify?.(`Не удалось добавить комментарий: ${error.message}`, 'error');
    setCommentDraft('');
    await load();
  }

  async function removeComment(item) {
    const canDelete = item.author_id === currentUserId;
    if (!canDelete || !window.confirm('Удалить комментарий?')) return;
    setBusy(true);
    const { error } = await supabase.from('task_comments').delete().eq('id', item.id);
    setBusy(false);
    if (error) return notify?.(`Не удалось удалить комментарий: ${error.message}`, 'error');
    await load();
  }

  if (!taskId) return null;

  return <section className="task-activity">
    <div className="task-activity-tabs">
      <button type="button" className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Файлы <span>{attachments.length}</span></button>
      <button type="button" className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>Комментарии <span>{comments.length}</span></button>
      <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>История <span>{history.length}</span></button>
    </div>

    {loading ? <div className="activity-loading"><div className="spinner" />Загружаем активность</div> : <>
      {tab === 'files' && <div className="activity-panel">
        <div className="activity-panel-head"><div><strong>Файлы результата</strong><span>До 15 МБ: PDF, Office, CSV/TXT, изображения и ZIP.</span></div>{editable && <><input ref={fileInput} className="file-input" type="file" onChange={uploadFile} disabled={busy} /><button type="button" className="button button-small" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Загрузка…' : '+ Добавить файл'}</button></>}</div>
        <div className="attachment-list">{attachments.length ? attachments.map((item) => <div className="attachment-row" key={item.id}><div className="attachment-icon">↗</div><div className="attachment-copy"><strong>{item.file_name}</strong><span>{bytes(item.size_bytes)} · {dateTime(item.created_at)} · {actorName(item.uploaded_by, profiles)}</span></div><button type="button" className="button button-small button-ghost" onClick={() => downloadFile(item)}>Скачать</button>{editable && <button type="button" className="icon-button danger" disabled={busy} onClick={() => removeFile(item)} aria-label="Удалить файл">×</button>}</div>) : <div className="activity-empty">Файлов пока нет.</div>}</div>
      </div>}

      {tab === 'comments' && <div className="activity-panel">
        <div className="comment-list">{comments.length ? comments.map((item) => { const person = profileMap.get(item.author_id); return <div className="comment-row" key={item.id}><div className="avatar avatar-small">{(person?.full_name || '?').slice(0, 1).toUpperCase()}</div><div className="comment-content"><div className="comment-meta"><strong>{person?.full_name || 'Пользователь'}</strong><span>{dateTime(item.created_at)}{item.updated_at !== item.created_at ? ' · изменён' : ''}</span>{item.author_id === currentUserId && <button type="button" onClick={() => removeComment(item)} disabled={busy}>Удалить</button>}</div><p>{item.body}</p></div></div>; }) : <div className="activity-empty">Комментариев пока нет.</div>}</div>
        {editable && <form className="comment-form" onSubmit={addComment}><textarea rows={3} maxLength={5000} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Написать комментарий…" /><button className="button button-primary" type="submit" disabled={busy || !commentDraft.trim()}>Отправить</button></form>}
      </div>}

      {tab === 'history' && <div className="activity-panel history-list">{history.length ? history.map((item) => <div className="history-row" key={item.id}><span className="history-dot" /><div><strong>{actorName(item.actor_id, profiles)}</strong> {historyText(item)}<span>{dateTime(item.created_at)}</span></div></div>) : <div className="activity-empty">История пока пуста.</div>}</div>}
    </>}
  </section>;
}
