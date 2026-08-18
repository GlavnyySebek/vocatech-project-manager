import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import AppV2 from './AppV2';

function errorMessage(error) {
  return error?.message || error?.error_description || String(error || 'Неизвестная ошибка');
}

function hasPasswordFlow() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const type = params.get('type');
  return type === 'invite' || type === 'recovery';
}

function clearAuthHash() {
  if (!window.location.hash) return;
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
}

export default function AppGate() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [passwordFlow, setPasswordFlow] = useState(() => hasPasswordFlow());
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function loadProfile(user) {
    if (!user) {
      setProfile(null);
      return null;
    }

    const { data, error: profileError } = await supabase
      .from('profiles')
      .select('id,full_name,role,status')
      .eq('id', user.id)
      .single();

    if (profileError) {
      setError('Не удалось проверить профиль пользователя.');
      return null;
    }

    setProfile(data);
    return data;
  }

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(errorMessage(sessionError));
      const nextSession = data?.session || null;
      setSession(nextSession);
      if (nextSession?.user) await loadProfile(nextSession.user);
      if (mounted) setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') setPasswordFlow(true);
      setTimeout(async () => {
        await loadProfile(nextSession?.user);
        if (mounted) setLoading(false);
      }, 0);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function savePassword(event) {
    event.preventDefault();
    setError('');

    if (password.length < 12) {
      setError('Пароль должен содержать минимум 12 символов.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Пароли не совпадают.');
      return;
    }

    setBusy(true);

    try {
      if (profile?.status === 'pending') {
        const { data, error: functionError } = await supabase.functions.invoke('manage-users', {
          body: { action: 'complete-invite', password },
        });

        if (functionError || data?.error) {
          throw new Error(data?.error || errorMessage(functionError));
        }
      } else {
        const { error: passwordError } = await supabase.auth.updateUser({ password });
        if (passwordError) throw passwordError;
      }

      setPassword('');
      setConfirmPassword('');
      setPasswordFlow(false);
      clearAuthHash();
      await loadProfile(session?.user);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setPasswordFlow(false);
    clearAuthHash();
  }

  if (loading) {
    return <div className="center-screen"><div className="spinner" />Проверяем безопасный вход</div>;
  }

  const pendingOnboarding = Boolean(session && profile?.status === 'pending');
  const activePasswordFlow = Boolean(session && profile?.status === 'active' && passwordFlow);

  if (pendingOnboarding || activePasswordFlow) {
    const firstLogin = pendingOnboarding;
    return <main className="auth-page password-setup-page">
      <section className="auth-brand">
        <div className="brand brand-large"><span>VOCA</span><b>tech</b></div>
        <div className="eyebrow">БЕЗОПАСНЫЙ ДОСТУП</div>
        <h1>{firstLogin ? 'Первый вход' : 'Новый пароль'}</h1>
        <p>{firstLogin ? 'Создайте личный пароль. До этого момента доступ к проектам и задачам закрыт.' : 'Задайте новый пароль для входа в VocaTech Control.'}</p>
      </section>

      <section className="auth-card">
        <div className="eyebrow">{firstLogin ? 'АКТИВАЦИЯ АККАУНТА' : 'СМЕНА ПАРОЛЯ'}</div>
        <h2>{firstLogin ? 'Придумайте пароль' : 'Введите новый пароль'}</h2>
        <p>Минимум 12 символов. Дополнительные требования проверяет Supabase Auth.</p>
        <form className="form-stack" onSubmit={savePassword}>
          <label>Новый пароль<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label>Повторите пароль<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          {error && <div className="auth-error">{error}</div>}
          <button className="button button-primary" disabled={busy}>{busy ? 'Сохраняем…' : firstLogin ? 'Создать пароль и войти' : 'Сохранить пароль'}</button>
        </form>
        <button type="button" className="link-button" onClick={firstLogin ? signOut : () => { setPasswordFlow(false); clearAuthHash(); }} disabled={busy}>{firstLogin ? 'Выйти' : 'Отмена'}</button>
      </section>
    </main>;
  }

  return <AppV2 />;
}
