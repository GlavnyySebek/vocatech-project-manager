import { useEffect, useState } from 'react';
import { supabase } from './supabase';

function App(){
  const [session,setSession]=useState(null);
  const [profile,setProfile]=useState(null);
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [users,setUsers]=useState([]);

  async function loadProfile(current){
    if(!current) return;
    const {data}=await supabase.from('profiles').select('*').eq('id',current.id).single();
    setProfile(data);
  }

  async function loadUsers(){
    const {data,error}=await supabase.functions.invoke('manage-users',{body:{action:'list'}});
    if(!error) setUsers(data.users||[]);
  }

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{
      setSession(data.session);
      loadProfile(data.session?.user);
    });
    const {data:listener}=supabase.auth.onAuthStateChange((_event,newSession)=>{
      setSession(newSession);
      loadProfile(newSession?.user);
    });
    return ()=>listener.subscription.unsubscribe();
  },[]);

  async function login(){
    await supabase.auth.signInWithPassword({email,password});
  }

  async function inviteDemo(){
    await loadUsers();
  }

  if(!session) return <main style={{padding:40}}>
    <h1>VocaTech Project Manager</h1>
    <input placeholder="email" value={email} onChange={e=>setEmail(e.target.value)}/>
    <input placeholder="password" type="password" value={password} onChange={e=>setPassword(e.target.value)}/>
    <button onClick={login}>Войти</button>
  </main>;

  return <main style={{padding:40}}>
    <h1>VocaTech Project Manager</h1>
    <p>Пользователь: {profile?.full_name || session.user.email}</p>
    <p>Роль: {profile?.role}</p>
    {profile?.role==='creator' && <section>
      <h2>Управление пользователями</h2>
      <button onClick={inviteDemo}>Обновить список</button>
      {users.map(u=><div key={u.id}>{u.full_name} — {u.role}</div>)}
    </section>}
  </main>
}

export default App;
