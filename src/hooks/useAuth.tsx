import type { Session } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { callFn, type AppInfo } from "@/lib/api";
import { supabase } from "@/lib/supabase";

interface AuthState {
  session: Session | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });
  const qc = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, loading: false }));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setState({ session, loading: false });
      // Al salir no queda nada de la sesión anterior en memoria.
      if (event === "SIGNED_OUT") qc.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** ¿La persona es admin? */
export function useIsAdmin(): boolean {
  const { session } = useAuth();
  const uid = session?.user.id;
  const { data } = useQuery({
    queryKey: ["is-admin", uid],
    enabled: !!uid,
    queryFn: async () => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", uid!).eq("role", "admin").maybeSingle();
      return !!data;
    },
  });
  return data === true;
}

/** Qué está encendido en esta instalación (IA, calendario, presencial). */
export function useAppInfo() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["app-info"],
    enabled: !!session,
    staleTime: 5 * 60_000,
    queryFn: () => callFn<AppInfo>("app-info"),
  });
}
