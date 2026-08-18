import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';

const STATUS_COLUMNS = [
  ['backlog', 'Бэклог'],
  ['plan', 'Планируется'],
  ['work', 'В работе'],
  ['check', 'Проверка'],
  ['done', 'Готово'],
];

const PRIORITY_LABELS = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const TYPE_LABELS = { pilot: 'Пилот', internal: 'Внутренний' };
const ROLE_LABELS = { creator: 'Создатель', admin: 'Администратор', user: 'Пользователь' };

const emptyProjectForm = {
  name: '', client_name: '', description: '', type: 'internal', priority: 'medium',
  start_date: '', deadline: '', responsibles: [], observers: [],
};

const emptyTaskForm = {
  title: '', description: '', priority: 'medium', status: 'backlog', result: '',
  group_name: '', start_date: '', due_date: '', responsibles: [], observers: [],
};

function cx(...items) { return items.filter(Boolean).join(' '); }
function formatDate(value) { if (!value) return '—'; const date = new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ru-RU').format(date); }
function initials(value) { return String(value || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((item) => item[0]?.toUpperCase()).join('') || '?'; }
function errorMessage(error) { return error?.message || error?.error_description || String(error || 'Неизвестная ошибка'); }

function Modal({ title, subtitle, children, footer, onClose, wide = false }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть">×</button></header>
      <div className="modal-body">{children}</div>{footer && <footer className="modal-footer">{footer}</footer>}
    </section>
  </div>;
}

function MemberPicker({ profiles, responsibles, observers, disabled, onChange }) {
  function setKind(userId, kind, checked) {
    let nextResponsibles = responsibles.filter((id) => id !== userId);
    let nextObservers = observers.filter((id) => id !== userId);
    if (checked && kind === 'responsible') nextResponsibles = [...nextResponsibles, userId];
    if (checked && kind === 'observer') nextObservers = [...nextObservers, userId];
    onChange(nextResponsibles, nextObservers);
  }
  return <div className="member-grid">
    <div><div className="member-grid-title">Ответственные</div><div className="member-list">{profiles.map((person) => <label className="member-option" key={`r-${person.id}`}><input type="checkbox" checked={responsibles.includes(person.id)} disabled={disabled} onChange={(event) => setKind(person.id, 'responsible', event.target.checked)} /><span className="avatar avatar-small">{initials(person.full_name || person.id)}</span><span>{person.full_name || 'Без имени'}</span></label>)}</div></div>
    <div><div className="member-grid-title">Наблюдатели</div><div className="member-list">{profiles.map((person) => <label className="member-option" key={`o-${person.id}`}><input type="checkbox" checked={observers.includes(person.id)} disabled={disabled} onChange={(event) => setKind(person.id, 'observer', event.target.checked)} /><span className="avatar avatar-small">{initials(person.full_name || person.id)}</span><span>{person.full_name || 'Без имени'}</span></label>)}</div></div>
  </div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPasswordChange, setShowPasswordChange] = useState(() => /type=(invite|recovery)/.test(window.location.hash));
  const [profiles, setProfiles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [projectMembers, setProjectMembers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskMembers, setTaskMembers] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [activeView, setActiveView] = useState('board');
  const [groupMode, setGroupMode] = useState('none');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [dragTaskId, setDragTaskId] = useState('');
  const [projectModal, setProjectModal] = useState(null);
  const [projectForm, setProjectForm] = useState(emptyProjectForm);
  const [taskModal, setTaskModal] = useState(null);
  const [taskForm, setTaskForm] = useState(emptyTaskForm);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ fullName: '', email: '', role: 'user' });
  const [teamUsers, setTeamUsers] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const reloadTimer = useRef(null);

  const currentUserId = session?.user?.id || '';
  const isCreator = profile?.role === 'creator';
  const isAdminOrCreator = profile?.role === 'creator' || profile?.role === 'admin';
  const activeProject = useMemo(() => projects.find((item) => item.id === activeProjectId) || projects[0] || null, [projects, activeProjectId]);
  const activeTasks = useMemo(() => tasks.filter((task) => task.project_id === activeProject?.id), [tasks, activeProject?.id]);
  const activeProjectMembers = useMemo(() => projectMembers.filter((item) => item.project_id === activeProject?.id), [projectMembers, activeProject?.id]);
  const stats = useMemo(() => { const total = activeTasks.length; const done = activeTasks.filter((task) => task.status === 'done').length; const work = activeTasks.filter((task) => task.status === 'work').length; return { total, done, work, progress: total ? Math.round((done / total) * 100) : 0 }; }, [activeTasks]);
  const groupSuggestions = useMemo(() => [...new Set(activeTasks.map((task) => task.group_name?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [activeTasks]);

  function notify(message, type = 'info') { setNotice({ message, type, id: Date.now() }); }

  async function loadProfile(user) {
    if (!user) { setProfile(null); return null; }
    const { data, error } = await supabase.from('profiles').select('id,full_name,role,status,created_at,updated_at').eq('id', user.id).single();
    if (error) { notify(`Не удалось загрузить профиль: ${errorMessage(error)}`, 'error'); setProfile(null); return null; }
    setProfile(data); return data;
  }

  async function loadWorkspace({ silent = false } = {}) {
    if (!session?.user) return;
    if (!silent) setWorkspaceLoading(true);
    try {
      const [projectsResult, projectMembersResult, tasksResult, taskMembersResult, profilesResult] = await Promise.all([
        supabase.from('projects').select('id,name,client_name,description,type,priority,start_date,deadline,created_by,created_at,updated_at').order('created_at'),
        supabase.from('project_members').select('project_id,user_id,kind,created_at'),
        supabase.from('tasks').select('id,project_id,title,description,status,priority,result,group_name,start_date,due_date,schedule_owner,schedule_start_week,schedule_end_week,sort_order,created_by,created_at,updated_at').order('sort_order').order('created_at'),
        supabase.from('task_members').select('task_id,user_id,kind,created_at'),
        supabase.from('profiles').select('id,full_name,role,status').eq('status', 'active').order('full_name'),
      ]);
      const firstError = [projectsResult, projectMembersResult, tasksResult, taskMembersResult, profilesResult].find((result) => result.error)?.error;
      if (firstError) throw firstError;
      const nextProjects = projectsResult.data || [];
      setProjects(nextProjects); setProjectMembers(projectMembersResult.data || []); setTasks(tasksResult.data || []); setTaskMembers(taskMembersResult.data || []); setProfiles(profilesResult.data || []);
      setActiveProjectId((previous) => nextProjects.some((item) => item.id === previous) ? previous : (nextProjects[0]?.id || ''));
    } catch (error) { notify(`Не удалось загрузить рабочее пространство: ${errorMessage(error)}`, 'error'); }
    finally { if (!silent) setWorkspaceLoading(false); }
  }

  function scheduleWorkspaceReload() { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => loadWorkspace({ silent: true }), 250); }

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data, error }) => { if (!mounted) return; if (error) notify(errorMessage(error), 'error'); setSession(data?.session || null); setAuthLoading(false); if (data?.session?.user) loadProfile(data.session.user); });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => { setSession(nextSession); if (event === 'PASSWORD_RECOVERY') setShowPasswordChange(true); setTimeout(() => loadProfile(nextSession?.user), 0); });
    return () => { mounted = false; listener.subscription.unsubscribe(); clearTimeout(reloadTimer.current); };
  }, []);

  useEffect(() => {
    if (!session || !profile || profile.status !== 'active') return undefined;
    loadWorkspace();
    const channel = supabase.channel(`vocatech-control-${currentUserId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, scheduleWorkspaceReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, scheduleWorkspaceReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, scheduleWorkspaceReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_members' }, scheduleWorkspaceReload).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, profile?.status]);

  useEffect(() => { if (!activeProject) return; const saved = localStorage.getItem(`vtc-group-mode:${activeProject.id}`); setGroupMode(saved === 'group' || saved === 'none' ? saved : (activeProject.type === 'pilot' ? 'group' : 'none')); }, [activeProject?.id]);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(null), 4200); return () => clearTimeout(timer); }, [notice]);

  async function login(event) { event?.preventDefault(); if (!email.trim() || !password) return notify('Введите email и пароль', 'error'); setBusy(true); const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password }); setBusy(false); if (error) return notify('Не удалось войти. Проверьте email и пароль.', 'error'); setPassword(''); }
  async function resetPassword() { if (!email.trim()) return notify('Сначала укажите email', 'error'); setBusy(true); const redirectTo = window.location.href.split('#')[0].split('?')[0]; const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo }); setBusy(false); if (error) return notify(errorMessage(error), 'error'); notify('Письмо для восстановления пароля отправлено', 'success'); }
  async function saveNewPassword(event) { event?.preventDefault(); if (newPassword.length < 10) return notify('Пароль должен содержать минимум 10 символов', 'error'); setBusy(true); const { error } = await supabase.auth.updateUser({ password: newPassword }); setBusy(false); if (error) return notify(errorMessage(error), 'error'); setNewPassword(''); setShowPasswordChange(false); notify('Пароль обновлён', 'success'); }
  async function logout() { await supabase.auth.signOut(); setProjects([]); setTasks([]); setProfile(null); setActiveView('board'); }

  function canEditProject(projectId) { return isAdminOrCreator || projectMembers.some((item) => item.project_id === projectId && item.user_id === currentUserId); }
  function canEditTask(taskId) { return isAdminOrCreator || taskMembers.some((item) => item.task_id === taskId && item.user_id === currentUserId); }
  function projectPeople(kind) { const ids = activeProjectMembers.filter((item) => item.kind === kind).map((item) => item.user_id); return profiles.filter((person) => ids.includes(person.id)); }
  function taskPeople(taskId, kind) { const ids = taskMembers.filter((item) => item.task_id === taskId && item.kind === kind).map((item) => item.user_id); return profiles.filter((person) => ids.includes(person.id)); }
  function setGrouping(value) { setGroupMode(value); if (activeProject) localStorage.setItem(`vtc-group-mode:${activeProject.id}`, value); }
  function toggleCollapsed(status, group) { const key = `${status}:${group}`; setCollapsedGroups((current) => ({ ...current, [key]: !current[key] })); }

  function openProjectEditor(project = null) {
    if (project && !canEditProject(project.id)) return notify('У вас нет прав на редактирование проекта', 'error');
    if (!project && !isAdminOrCreator) return notify('Создавать проекты может Создатель или Администратор', 'error');
    const members = project ? projectMembers.filter((item) => item.project_id === project.id) : [];
    setProjectForm(project ? { name: project.name || '', client_name: project.client_name || '', description: project.description || '', type: project.type || 'internal', priority: project.priority || 'medium', start_date: project.start_date || '', deadline: project.deadline || '', responsibles: members.filter((item) => item.kind === 'responsible').map((item) => item.user_id), observers: members.filter((item) => item.kind === 'observer').map((item) => item.user_id) } : { ...emptyProjectForm, start_date: new Date().toISOString().slice(0, 10), responsibles: currentUserId ? [currentUserId] : [] });
    setProjectModal(project ? { mode: 'edit', id: project.id } : { mode: 'create' });
  }

  async function saveProject(event) {
    event.preventDefault();
    if (!projectForm.name.trim()) return notify('Введите название проекта', 'error');
    if (!projectForm.responsibles.length && !projectForm.observers.length) return notify('Добавьте хотя бы одного участника проекта', 'error');
    setBusy(true);
    try {
      if (projectModal.mode === 'create') {
        const { data, error } = await supabase.rpc('create_project_with_template', { p_name: projectForm.name.trim(), p_client_name: projectForm.client_name.trim(), p_description: projectForm.description.trim(), p_type: projectForm.type, p_priority: projectForm.priority, p_start_date: projectForm.start_date || null, p_deadline: projectForm.deadline || null, p_responsibles: projectForm.responsibles, p_observers: projectForm.observers });
        if (error) throw error; setActiveProjectId(data || ''); notify(projectForm.type === 'pilot' ? 'Пилот создан со стандартным план-графиком' : 'Проект создан', 'success');
      } else {
        const { error: updateError } = await supabase.from('projects').update({ name: projectForm.name.trim(), client_name: projectForm.client_name.trim(), description: projectForm.description.trim(), type: projectForm.type, priority: projectForm.priority, start_date: projectForm.start_date || null, deadline: projectForm.deadline || null }).eq('id', projectModal.id); if (updateError) throw updateError;
        const { error: memberError } = await supabase.rpc('replace_project_members', { p_project_id: projectModal.id, p_responsibles: projectForm.responsibles, p_observers: projectForm.observers }); if (memberError) throw memberError; notify('Проект обновлён', 'success');
      }
      setProjectModal(null); await loadWorkspace({ silent: true });
    } catch (error) { notify(`Не удалось сохранить проект: ${errorMessage(error)}`, 'error'); }
    finally { setBusy(false); }
  }

  async function deleteProject() { if (!activeProject || !isAdminOrCreator) return; if (!window.confirm(`Удалить проект «${activeProject.name}» и все его задачи?`)) return; setBusy(true); const { error } = await supabase.from('projects').delete().eq('id', activeProject.id); setBusy(false); if (error) return notify(errorMessage(error), 'error'); notify('Проект удалён', 'success'); await loadWorkspace({ silent: true }); }

  function openTaskEditor(task = null, forcedStatus = null) {
    if (!activeProject) return;
    const editable = task ? canEditTask(task.id) : canEditProject(activeProject.id);
    if (!task && !editable) return notify('У вас нет прав на создание задач в этом проекте', 'error');
    const members = task ? taskMembers.filter((item) => item.task_id === task.id) : [];
    setTaskForm(task ? { title: task.title || '', description: task.description || '', priority: task.priority || 'medium', status: forcedStatus || task.status || 'backlog', result: task.result || '', group_name: task.group_name || '', start_date: task.start_date || '', due_date: task.due_date || '', responsibles: members.filter((item) => item.kind === 'responsible').map((item) => item.user_id), observers: members.filter((item) => item.kind === 'observer').map((item) => item.user_id) } : { ...emptyTaskForm, responsibles: currentUserId ? [currentUserId] : [] });
    setTaskModal(task ? { mode: 'edit', id: task.id, readonly: !editable } : { mode: 'create', readonly: false });
  }

  async function saveTask(event) {
    event.preventDefault(); if (taskModal?.readonly) return;
    if (!taskForm.title.trim()) return notify('Введите название задачи', 'error');
    if (!taskForm.responsibles.length && !taskForm.observers.length) return notify('Добавьте хотя бы одного участника задачи', 'error');
    if (taskForm.status === 'done' && !taskForm.result.trim()) return notify('Для статуса «Готово» заполните результат задачи', 'error');
    setBusy(true);
    try {
      if (taskModal.mode === 'create') {
        const { error } = await supabase.rpc('create_task_with_members', { p_project_id: activeProject.id, p_title: taskForm.title.trim(), p_description: taskForm.description.trim(), p_priority: taskForm.priority, p_status: taskForm.status, p_result: taskForm.result.trim(), p_group_name: taskForm.group_name.trim(), p_start_date: taskForm.start_date || null, p_due_date: taskForm.due_date || null, p_responsibles: taskForm.responsibles, p_observers: taskForm.observers }); if (error) throw error; notify('Задача создана', 'success');
      } else {
        const { error: updateError } = await supabase.from('tasks').update({ title: taskForm.title.trim(), description: taskForm.description.trim(), priority: taskForm.priority, status: taskForm.status, result: taskForm.result.trim(), group_name: taskForm.group_name.trim(), start_date: taskForm.start_date || null, due_date: taskForm.due_date || null }).eq('id', taskModal.id); if (updateError) throw updateError;
        const { error: memberError } = await supabase.rpc('replace_task_members', { p_task_id: taskModal.id, p_responsibles: taskForm.responsibles, p_observers: taskForm.observers }); if (memberError) throw memberError; notify('Задача обновлена', 'success');
      }
      setTaskModal(null); await loadWorkspace({ silent: true });
    } catch (error) { notify(`Не удалось сохранить задачу: ${errorMessage(error)}`, 'error'); }
    finally { setBusy(false); }
  }

  async function moveTask(task, nextStatus) {
    if (!canEditTask(task.id)) return notify('У вас нет прав на изменение этой задачи', 'error');
    if (task.status === nextStatus) return;
    if (nextStatus === 'done' && !task.result?.trim()) { openTaskEditor(task, 'done'); notify('Заполните результат, чтобы завершить задачу', 'info'); return; }
    const previousTasks = tasks; setTasks((items) => items.map((item) => item.id === task.id ? { ...item, status: nextStatus } : item));
    const { error } = await supabase.from('tasks').update({ status: nextStatus }).eq('id', task.id); if (error) { setTasks(previousTasks); notify(errorMessage(error), 'error'); }
  }

  async function deleteTask(taskId) { if (!isAdminOrCreator) return notify('Удалять задачи может Создатель или Администратор', 'error'); const task = tasks.find((item) => item.id === taskId); if (!task || !window.confirm(`Удалить задачу «${task.title}»?`)) return; setBusy(true); const { error } = await supabase.from('tasks').delete().eq('id', taskId); setBusy(false); if (error) return notify(errorMessage(error), 'error'); setTaskModal(null); notify('Задача удалена', 'success'); await loadWorkspace({ silent: true }); }

  async function loadTeam() { if (!isCreator) return; setTeamLoading(true); const { data, error } = await supabase.functions.invoke('manage-users', { body: { action: 'list' } }); setTeamLoading(false); if (error || data?.error) return notify(data?.error || errorMessage(error), 'error'); setTeamUsers(data?.users || []); }
  useEffect(() => { if (activeView === 'team' && isCreator) loadTeam(); }, [activeView, isCreator]);

  async function inviteUser(event) { event.preventDefault(); if (!inviteForm.fullName.trim() || !inviteForm.email.trim()) return notify('Заполните имя и email', 'error'); setBusy(true); const redirectTo = window.location.href.split('#')[0].split('?')[0]; const { data, error } = await supabase.functions.invoke('manage-users', { body: { action: 'invite', fullName: inviteForm.fullName.trim(), email: inviteForm.email.trim(), role: inviteForm.role, redirectTo } }); setBusy(false); if (error || data?.error) return notify(data?.error || errorMessage(error), 'error'); setInviteOpen(false); setInviteForm({ fullName: '', email: '', role: 'user' }); notify('Приглашение отправлено', 'success'); await loadTeam(); await loadWorkspace({ silent: true }); }
  async function updateTeamUser(user, patch) { if (!isCreator || user.role === 'creator') return; const next = { ...user, ...patch }; setBusy(true); const { data, error } = await supabase.functions.invoke('manage-users', { body: { action: 'update', userId: user.id, fullName: next.full_name, role: next.role, status: next.status } }); setBusy(false); if (error || data?.error) return notify(data?.error || errorMessage(error), 'error'); notify('Пользователь обновлён', 'success'); await loadTeam(); await loadWorkspace({ silent: true }); }

  function renderTaskCard(task) {
    const responsible = taskPeople(task.id, 'responsible');
    const overdue = task.due_date && task.status !== 'done' && new Date(`${task.due_date}T23:59:59`) < new Date();
    const editable = canEditTask(task.id);
    return <article key={task.id} className={cx('task-card', editable && 'task-card-editable')} draggable={editable} onDragStart={(event) => { setDragTaskId(task.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); }} onDragEnd={() => setDragTaskId('')} onClick={() => openTaskEditor(task)}>
      <div className="task-card-top"><span className={cx('priority-dot', `priority-${task.priority}`)} title={PRIORITY_LABELS[task.priority]} /><span className="task-title">{task.title}</span>{!editable && <span className="lock" title="Только просмотр">↗</span>}</div>
      {task.description && <p className="task-description">{task.description}</p>}
      <div className="task-chips">{responsible.slice(0, 2).map((person) => <span className="chip" key={person.id}>{person.full_name || 'Без имени'}</span>)}{responsible.length > 2 && <span className="chip">+{responsible.length - 2}</span>}{task.schedule_owner && <span className="chip chip-blue">План: {task.schedule_owner}</span>}{task.due_date && <span className={cx('chip', overdue && 'chip-danger')}>Срок {formatDate(task.due_date)}</span>}{task.result?.trim() && <span className="chip chip-success">✓ Результат</span>}{groupMode === 'none' && task.group_name && <span className="chip chip-purple">{task.group_name}</span>}</div>
    </article>;
  }

  function renderColumn(status, title) {
    const columnTasks = activeTasks.filter((task) => task.status === status);
    let content;
    if (groupMode === 'group') {
      const groups = new Map(); columnTasks.forEach((task) => { const name = task.group_name?.trim() || 'Без группы'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(task); });
      const entries = [...groups.entries()].sort(([a], [b]) => { if (a === 'Без группы') return 1; if (b === 'Без группы') return -1; const aNumber = Number((/^\s*(\d+)/.exec(a) || [])[1] || 1000); const bNumber = Number((/^\s*(\d+)/.exec(b) || [])[1] || 1000); return aNumber - bNumber || a.localeCompare(b, 'ru'); });
      content = entries.map(([groupName, groupTasks]) => { const collapseKey = `${status}:${groupName}`; const collapsed = Boolean(collapsedGroups[collapseKey]); return <section className={cx('task-group', collapsed && 'task-group-collapsed')} key={groupName}><button className="task-group-header" type="button" onClick={() => toggleCollapsed(status, groupName)}><span>{groupName}</span><span className="task-group-count">{groupTasks.length} {collapsed ? '▸' : '▾'}</span></button>{!collapsed && <div className="task-group-body">{groupTasks.map(renderTaskCard)}</div>}</section>; });
    } else content = columnTasks.map(renderTaskCard);
    return <section className={cx('kanban-column', dragTaskId && 'kanban-column-drop')} key={status} onDragOver={(event) => { if (dragTaskId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const id = dragTaskId || event.dataTransfer.getData('text/plain'); const task = tasks.find((item) => item.id === id); if (task) moveTask(task, status); setDragTaskId(''); }}><header className="column-header"><span>{title}</span><span className="count-badge">{columnTasks.length}</span></header><div className="column-body">{content?.length ? content : <div className="empty-column">Перетащите задачу сюда</div>}</div></section>;
  }

  if (authLoading) return <div className="center-screen"><div className="spinner" /><span>Загружаем VocaTech Control</span></div>;
  if (!session) return <main className="auth-page"><section className="auth-brand"><div className="brand brand-large"><span>VOCA</span><b>tech</b></div><div className="auth-kicker">PROJECT OPERATING SYSTEM</div><h1>VocaTech Control</h1><p>Проекты, задачи, сроки и ответственность команды — в одном защищённом пространстве.</p><div className="auth-points"><span>● Ролевой доступ</span><span>● Supabase RLS</span><span>● Realtime</span></div></section><section className="auth-card"><div className="auth-card-label">Вход в систему</div><h2>Рабочее пространство VocaTech</h2><p>Саморегистрация отключена. Доступ выдаёт Создатель.</p><form onSubmit={login} className="auth-form"><label>Email<input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.ru" /></label><label>Пароль<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••••" /></label><button className="button button-primary button-full" disabled={busy} type="submit">{busy ? 'Входим…' : 'Войти'}</button></form><button className="link-button" type="button" onClick={resetPassword} disabled={busy}>Восстановить пароль</button></section>{notice && <div className={cx('toast', `toast-${notice.type}`)}>{notice.message}</div>}</main>;
  if (!profile) return <div className="center-screen"><div className="spinner" /><span>Проверяем профиль и права</span></div>;
  if (profile.status !== 'active') return <div className="center-screen blocked-screen"><div className="blocked-icon">!</div><h2>Доступ пока не активирован</h2><p>Ваш профиль создан, но Создатель ещё не выдал рабочий доступ.</p><button className="button" type="button" onClick={logout}>Выйти</button></div>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span>VOCA</span><b>tech</b><em>Control</em></div><nav className="main-nav"><button className={cx('nav-item', activeView === 'board' && 'nav-item-active')} type="button" onClick={() => setActiveView('board')}>Проекты</button>{isCreator && <button className={cx('nav-item', activeView === 'team' && 'nav-item-active')} type="button" onClick={() => setActiveView('team')}>Команда</button>}</nav><div className="user-menu"><div className="avatar">{initials(profile.full_name || session.user.email)}</div><div className="user-copy"><strong>{profile.full_name || session.user.email}</strong><span>{ROLE_LABELS[profile.role]}</span></div><button className="button button-ghost button-small" type="button" onClick={() => setShowPasswordChange(true)}>Пароль</button><button className="button button-ghost button-small" type="button" onClick={logout}>Выйти</button></div></header>
    {activeView === 'board' && <main className="workspace"><section className="project-hero"><div className="hero-main"><div className="eyebrow">ПРОЕКТНОЕ ПРОСТРАНСТВО</div><select className="project-title-select" value={activeProject?.id || ''} onChange={(event) => setActiveProjectId(event.target.value)} aria-label="Выберите проект">{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{activeProject ? <><div className="hero-tags"><span className="pill">{TYPE_LABELS[activeProject.type]}</span><span className={cx('pill', `pill-${activeProject.priority}`)}>{PRIORITY_LABELS[activeProject.priority]}</span><span className="pill pill-access">{canEditProject(activeProject.id) ? 'Можно редактировать' : 'Только просмотр'}</span></div><p className="hero-description">{activeProject.description || 'Описание проекта пока не заполнено.'}</p></> : <p className="hero-description">Создайте первый проект.</p>}</div><div className="hero-actions">{activeProject && canEditProject(activeProject.id) && <button className="button" type="button" onClick={() => openProjectEditor(activeProject)}>Редактировать</button>}{isAdminOrCreator && <button className="button" type="button" onClick={() => openProjectEditor()}>+ Проект</button>}{activeProject && canEditProject(activeProject.id) && <button className="button button-primary" type="button" onClick={() => openTaskEditor()}>+ Задача</button>}{activeProject && isAdminOrCreator && <button className="button button-danger-ghost" type="button" onClick={deleteProject}>Удалить</button>}</div></section>
      {activeProject && <><section className="project-summary-grid"><div className="summary-card"><span>Клиент</span><strong>{activeProject.client_name || '—'}</strong></div><div className="summary-card"><span>Старт / дедлайн</span><strong>{formatDate(activeProject.start_date)} → {formatDate(activeProject.deadline)}</strong></div><div className="summary-card summary-people"><span>Ответственные</span><div className="people-row">{projectPeople('responsible').length ? projectPeople('responsible').map((person) => <span className="person-chip" key={person.id}>{person.full_name || 'Без имени'}</span>) : <strong>—</strong>}</div></div><div className="summary-card summary-people"><span>Наблюдатели</span><div className="people-row">{projectPeople('observer').length ? projectPeople('observer').map((person) => <span className="person-chip" key={person.id}>{person.full_name || 'Без имени'}</span>) : <strong>—</strong>}</div></div></section><section className="stats-row"><div className="stat"><span>Всего задач</span><strong>{stats.total}</strong></div><div className="stat"><span>В работе</span><strong>{stats.work}</strong></div><div className="stat"><span>Готово</span><strong>{stats.done}</strong></div><div className="stat stat-progress"><span>Прогресс</span><strong>{stats.progress}%</strong><div className="progress"><i style={{ width: `${stats.progress}%` }} /></div></div><label className="group-control">Группировка<select value={groupMode} onChange={(event) => setGrouping(event.target.value)}><option value="none">Без группировки</option><option value="group">По группам</option></select></label></section>{workspaceLoading ? <div className="board-loading"><div className="spinner" />Загружаем задачи</div> : <div className="board-scroll"><section className="kanban-board">{STATUS_COLUMNS.map(([status, title]) => renderColumn(status, title))}</section></div>}</>}
      {!workspaceLoading && !projects.length && <section className="empty-state"><div className="empty-state-icon">＋</div><h2>Проектов пока нет</h2><p>Создатель или Администратор может создать первое рабочее пространство.</p>{isAdminOrCreator && <button className="button button-primary" onClick={() => openProjectEditor()} type="button">Создать проект</button>}</section>}
    </main>}
    {activeView === 'team' && isCreator && <main className="workspace team-workspace"><section className="team-heading"><div><div className="eyebrow">АДМИНИСТРИРОВАНИЕ</div><h1>Команда</h1><p>Только Создатель приглашает пользователей, назначает роли и управляет доступом.</p></div><button className="button button-primary" type="button" onClick={() => setInviteOpen(true)}>+ Пригласить</button></section><section className="team-card"><div className="team-table-head"><span>Пользователь</span><span>Роль</span><span>Статус</span><span>Действие</span></div>{teamLoading ? <div className="team-loading"><div className="spinner" />Загружаем пользователей</div> : teamUsers.map((user) => <div className="team-row" key={user.id}><div className="team-person"><span className="avatar">{initials(user.full_name || user.email)}</span><div><strong>{user.full_name || 'Без имени'}</strong><span>{user.email}</span></div></div><div>{user.role === 'creator' ? <span className="role-lock">Создатель</span> : <select value={user.role} disabled={busy} onChange={(event) => updateTeamUser(user, { role: event.target.value })}><option value="admin">Администратор</option><option value="user">Пользователь</option></select>}</div><div><span className={cx('status-badge', user.status === 'active' ? 'status-active' : 'status-disabled')}>{user.status === 'active' ? 'Активен' : 'Заблокирован'}</span></div><div>{user.role !== 'creator' ? <button className={cx('button button-small', user.status === 'active' ? 'button-danger-ghost' : '')} type="button" disabled={busy} onClick={() => updateTeamUser(user, { status: user.status === 'active' ? 'disabled' : 'active' })}>{user.status === 'active' ? 'Заблокировать' : 'Активировать'}</button> : <span className="protected-copy">Защищённая роль</span>}</div></div>)}</section></main>}

    {projectModal && <Modal title={projectModal.mode === 'create' ? 'Новый проект' : 'Редактирование проекта'} subtitle={projectForm.type === 'pilot' && projectModal.mode === 'create' ? 'Для пилота автоматически создаются 23 задачи из план-графика.' : null} onClose={() => !busy && setProjectModal(null)} wide footer={<><button className="button button-ghost" type="button" onClick={() => setProjectModal(null)}>Отмена</button><button className="button button-primary" form="project-form" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></>}><form id="project-form" className="form-stack" onSubmit={saveProject}><div className="form-grid"><label>Название проекта<input value={projectForm.name} onChange={(event) => setProjectForm((form) => ({ ...form, name: event.target.value }))} maxLength={120} /></label><label>Клиент<input value={projectForm.client_name} onChange={(event) => setProjectForm((form) => ({ ...form, client_name: event.target.value }))} maxLength={160} /></label></div><label>Описание<textarea value={projectForm.description} onChange={(event) => setProjectForm((form) => ({ ...form, description: event.target.value }))} rows={3} /></label><div className="form-grid form-grid-3"><label>Тип<select value={projectForm.type} onChange={(event) => setProjectForm((form) => ({ ...form, type: event.target.value }))}><option value="internal">Внутренний</option><option value="pilot">Пилот</option></select></label><label>Приоритет<select value={projectForm.priority} onChange={(event) => setProjectForm((form) => ({ ...form, priority: event.target.value }))}><option value="high">Высокий</option><option value="medium">Средний</option><option value="low">Низкий</option></select></label><div /></div><div className="form-grid"><label>Дата старта<input type="date" value={projectForm.start_date} onChange={(event) => setProjectForm((form) => ({ ...form, start_date: event.target.value }))} /></label><label>Дедлайн<input type="date" value={projectForm.deadline} onChange={(event) => setProjectForm((form) => ({ ...form, deadline: event.target.value }))} /><small>{projectForm.type === 'pilot' && !projectForm.deadline ? 'Если оставить пустым — конец 21-й недели.' : 'Можно изменить вручную.'}</small></label></div><MemberPicker profiles={profiles} responsibles={projectForm.responsibles} observers={projectForm.observers} disabled={busy} onChange={(responsibles, observers) => setProjectForm((form) => ({ ...form, responsibles, observers }))} /></form></Modal>}

    {taskModal && <Modal title={taskModal.mode === 'create' ? 'Новая задача' : taskForm.title || 'Задача'} subtitle={taskModal.readonly ? 'У вас режим просмотра: задача не назначена вам.' : (taskForm.status === 'done' && !taskForm.result.trim() ? 'Чтобы завершить задачу, заполните результат.' : null)} onClose={() => !busy && setTaskModal(null)} wide footer={<>{taskModal.mode === 'edit' && isAdminOrCreator && <button className="button button-danger-ghost footer-left" type="button" onClick={() => deleteTask(taskModal.id)}>Удалить</button>}<button className="button button-ghost" type="button" onClick={() => setTaskModal(null)}>Закрыть</button>{!taskModal.readonly && <button className="button button-primary" form="task-form" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>}</>}><form id="task-form" className="form-stack" onSubmit={saveTask}><label>Название<input disabled={taskModal.readonly} value={taskForm.title} onChange={(event) => setTaskForm((form) => ({ ...form, title: event.target.value }))} maxLength={180} /></label><label>Описание<textarea disabled={taskModal.readonly} value={taskForm.description} onChange={(event) => setTaskForm((form) => ({ ...form, description: event.target.value }))} rows={3} /></label><div className="form-grid form-grid-3"><label>Приоритет<select disabled={taskModal.readonly} value={taskForm.priority} onChange={(event) => setTaskForm((form) => ({ ...form, priority: event.target.value }))}><option value="high">Высокий</option><option value="medium">Средний</option><option value="low">Низкий</option></select></label><label>Статус<select disabled={taskModal.readonly} value={taskForm.status} onChange={(event) => setTaskForm((form) => ({ ...form, status: event.target.value }))}>{STATUS_COLUMNS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Группа<input disabled={taskModal.readonly} list="group-suggestions" value={taskForm.group_name} onChange={(event) => setTaskForm((form) => ({ ...form, group_name: event.target.value }))} placeholder="Например: Запуск" /><datalist id="group-suggestions">{groupSuggestions.map((group) => <option value={group} key={group} />)}</datalist></label></div><div className="form-grid"><label>Плановый старт<input disabled={taskModal.readonly} type="date" value={taskForm.start_date} onChange={(event) => setTaskForm((form) => ({ ...form, start_date: event.target.value }))} /></label><label>Срок задачи<input disabled={taskModal.readonly} type="date" value={taskForm.due_date} onChange={(event) => setTaskForm((form) => ({ ...form, due_date: event.target.value }))} /></label></div><label className={cx('result-field', taskForm.status === 'done' && !taskForm.result.trim() && 'result-field-required')}>Результат задачи<textarea disabled={taskModal.readonly} value={taskForm.result} onChange={(event) => setTaskForm((form) => ({ ...form, result: event.target.value }))} rows={4} placeholder="Что сделано, что передано клиенту, какой получен результат" /><small>Файлы результата добавим следующим блоком. Текстовый результат обязателен для «Готово».</small></label><MemberPicker profiles={profiles} responsibles={taskForm.responsibles} observers={taskForm.observers} disabled={taskModal.readonly || busy} onChange={(responsibles, observers) => setTaskForm((form) => ({ ...form, responsibles, observers }))} /></form></Modal>}

    {inviteOpen && <Modal title="Пригласить пользователя" subtitle="Пользователь получит письмо Supabase и войдёт только после перехода по ссылке." onClose={() => !busy && setInviteOpen(false)} footer={<><button className="button button-ghost" type="button" onClick={() => setInviteOpen(false)}>Отмена</button><button className="button button-primary" form="invite-form" type="submit" disabled={busy}>{busy ? 'Отправляем…' : 'Отправить приглашение'}</button></>}><form id="invite-form" className="form-stack" onSubmit={inviteUser}><label>Имя<input value={inviteForm.fullName} onChange={(event) => setInviteForm((form) => ({ ...form, fullName: event.target.value }))} maxLength={120} /></label><label>Email<input type="email" value={inviteForm.email} onChange={(event) => setInviteForm((form) => ({ ...form, email: event.target.value }))} /></label><label>Роль<select value={inviteForm.role} onChange={(event) => setInviteForm((form) => ({ ...form, role: event.target.value }))}><option value="user">Пользователь</option><option value="admin">Администратор</option></select><small>Назначить ещё одного Создателя через интерфейс нельзя.</small></label></form></Modal>}
    {showPasswordChange && <Modal title="Новый пароль" subtitle="Минимум 10 символов. После сохранения используйте его для входа." onClose={() => !busy && setShowPasswordChange(false)} footer={<><button className="button button-ghost" type="button" onClick={() => setShowPasswordChange(false)}>Отмена</button><button className="button button-primary" form="password-form" type="submit" disabled={busy}>Сохранить пароль</button></>}><form id="password-form" className="form-stack" onSubmit={saveNewPassword}><label>Новый пароль<input autoComplete="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label></form></Modal>}
    {notice && <div className={cx('toast', `toast-${notice.type}`)}>{notice.message}</div>}
  </div>;
}

export default App;
