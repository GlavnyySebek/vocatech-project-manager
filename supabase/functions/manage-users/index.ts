import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const APP_ORIGIN = "https://glavnyysebek.github.io";
const APP_URL = "https://glavnyysebek.github.io/vocatech-project-manager/";

const corsHeaders = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  let secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (secretKeysRaw) {
    try {
      const keys = JSON.parse(secretKeysRaw);
      secretKey = keys?.default || Object.values(keys ?? {})[0] || secretKey;
    } catch {
      // Legacy service-role key remains a server-side fallback only.
    }
  }

  if (!url || !secretKey) throw new Error("Server credentials are not configured");

  return createClient(url, String(secretKey), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function bearerToken(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

async function requireAuthenticated(req: Request, admin: ReturnType<typeof getAdminClient>) {
  const token = bearerToken(req);
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Response("Unauthorized", { status: 401 });
  return data.user;
}

async function requireCreator(req: Request, admin: ReturnType<typeof getAdminClient>) {
  const user = await requireAuthenticated(req, admin);

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role, status")
    .eq("id", user.id)
    .single();

  if (profileError || !profile || profile.status !== "active" || profile.role !== "creator") {
    throw new Response("Forbidden", { status: 403 });
  }

  return user;
}

function cleanName(value: unknown) {
  return String(value ?? "").trim().slice(0, 120);
}

function cleanEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function allowedRole(value: unknown): "admin" | "user" | null {
  return value === "admin" || value === "user" ? value : null;
}

function allowedStatus(value: unknown): "active" | "disabled" | "pending" | null {
  return value === "active" || value === "disabled" || value === "pending" ? value : null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (origin && origin !== APP_ORIGIN) {
    return json({ error: "Forbidden origin" }, 403);
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = getAdminClient();
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "complete-invite") {
      const caller = await requireAuthenticated(req, admin);
      const password = String(body?.password || "");

      if (password.length < 12) {
        return json({ error: "Пароль должен содержать минимум 12 символов" }, 400);
      }

      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("id, role, status")
        .eq("id", caller.id)
        .single();

      if (profileError || !profile) return json({ error: "Профиль пользователя не найден" }, 404);
      if (profile.status !== "pending") return json({ error: "Приглашение уже активировано или недоступно" }, 409);
      if (profile.role === "creator") return json({ error: "Аккаунт Создателя не активируется через приглашение" }, 403);

      const { error: passwordError } = await admin.auth.admin.updateUserById(caller.id, { password });
      if (passwordError) return json({ error: passwordError.message }, 400);

      const { error: activateError } = await admin
        .from("profiles")
        .update({ status: "active" })
        .eq("id", caller.id)
        .eq("status", "pending");
      if (activateError) throw activateError;

      return json({ ok: true, status: "active" });
    }

    const caller = await requireCreator(req, admin);

    if (action === "list") {
      const { data, error } = await admin
        .from("profiles")
        .select("id,email,full_name,role,status,created_at,updated_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return json({ users: data ?? [], callerId: caller.id });
    }

    if (action === "invite") {
      const email = cleanEmail(body?.email);
      const fullName = cleanName(body?.fullName);
      const role = allowedRole(body?.role);

      if (!isEmail(email)) return json({ error: "Некорректный email" }, 400);
      if (!fullName) return json({ error: "Укажите имя пользователя" }, 400);
      if (!role) return json({ error: "Можно назначить только admin или user" }, 400);

      const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
        email,
        {
          redirectTo: APP_URL,
          data: { full_name: fullName },
        },
      );
      if (inviteError) return json({ error: inviteError.message }, 400);

      const invited = inviteData?.user;
      if (!invited?.id) return json({ error: "Supabase не вернул ID приглашенного пользователя" }, 500);

      const { error: profileError } = await admin
        .from("profiles")
        .upsert({
          id: invited.id,
          email,
          full_name: fullName,
          role,
          status: "pending",
        }, { onConflict: "id" });
      if (profileError) throw profileError;

      const { error: authUpdateError } = await admin.auth.admin.updateUserById(invited.id, {
        user_metadata: { full_name: fullName },
        app_metadata: { app_role: role },
      });
      if (authUpdateError) throw authUpdateError;

      return json({ ok: true, userId: invited.id, status: "pending" });
    }

    if (action === "update") {
      const targetId = String(body?.userId || "").trim();
      const role = allowedRole(body?.role);
      const status = allowedStatus(body?.status);
      const fullName = cleanName(body?.fullName);

      if (!targetId) return json({ error: "Не указан пользователь" }, 400);
      if (!role) return json({ error: "Можно назначить только admin или user" }, 400);
      if (!status) return json({ error: "Некорректный статус" }, 400);
      if (!fullName) return json({ error: "Укажите имя пользователя" }, 400);

      const { data: target, error: targetError } = await admin
        .from("profiles")
        .select("id,role,status")
        .eq("id", targetId)
        .single();
      if (targetError || !target) return json({ error: "Пользователь не найден" }, 404);
      if (target.role === "creator") return json({ error: "Роль Создателя защищена от изменений" }, 403);

      if (target.status === "pending" && status !== "pending") {
        return json({ error: "Пользователь должен сам завершить активацию и создать пароль" }, 409);
      }
      if (target.status !== "pending" && status === "pending") {
        return json({ error: "Нельзя вручную вернуть активный аккаунт в состояние приглашения" }, 409);
      }

      const { error: updateError } = await admin
        .from("profiles")
        .update({ full_name: fullName, role, status })
        .eq("id", targetId);
      if (updateError) throw updateError;

      const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, {
        user_metadata: { full_name: fullName },
        app_metadata: { app_role: role },
      });
      if (authUpdateError) throw authUpdateError;

      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    if (error instanceof Response) {
      return json({ error: error.status === 403 ? "Недостаточно прав" : "Требуется авторизация" }, error.status);
    }
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});
