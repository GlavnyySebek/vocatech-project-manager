import { useEffect, useState } from 'react';
import { supabase } from './supabase';

const columns = [
  ['backlog', 'Бэклог'],
  ['plan', 'Планируется'],
  ['work', 'В работе'],
  ['check', 'Проверка'],
  ['done', 'Готово'],
];

function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);

  async function loadProfile(user) {
    if (!user) return setProfile(null);
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile(data);
  }

  async function loadProject() {
    const { data } = await supabase
      .from('projects')
      .select('*, tasks(*)')
      .order('created_at');
    const current = data?.[0] || null;
    setProjects(data || []);
    setProject(current);
    setTasks(current?.tasks || []);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      loadProfile(data.session?.user);
    });
    const { data } = supabase.auth.onAuthStateChange((_, next) => {
      setSession(next);
      loadProfile(next?.user);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) loadProject();
  }, [session]);

  async function login() {
    await supabase.auth.signInWithPassword({ email, password });
  }

  async function moveTask(task, status) {
    if (status === 'done' && !task.result?.trim()) {
      alert('Перед завершением заполните результат задачи');
      return;
    }
    await supabase.from('tasks').update({ status }).eq('id', task.id);
    loadProject();
  }

  if (!session) {
    return <main className="login"><h1>VocaTech Control</h1><input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} /><input placeholder="Пароль" type="password" value={password} onChange={e => setPassword(e.target.value)} /><button onClick={login}>Войти</button></main>;
  }

  return <main><header><h1>VocaTech Control</h1><span>{profile?.full_name || session.user.email} · {profile?.role}</span></header><section className="project"><h2>{project?.name}</h2><p>Клиент: {project?.client_name}</p><p>Проектов: {projects.length}</p></section><section className="board">{columns.map(([key,title]) => <div className="column" key={key}><h3>{title}</h3>{tasks.filter(t => t.status === key).map(task => <article className="card" key={task.id}><b>{task.title}</b><p>{task.description}</p><small>{task.group_name}</small><div>{columns.map(([next,label]) => <button key={next} onClick={() => moveTask(task,next)}>{label}</button>)}</div></article>)}</div>)}</section></main>;
}

export default App;
